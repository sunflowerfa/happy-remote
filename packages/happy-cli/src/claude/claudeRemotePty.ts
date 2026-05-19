/**
 * PTY-based remote Claude driver
 *
 * Runs `claude` as an interactive child via node-pty, so the underlying
 * /v1/messages calls bill against the user's INTERACTIVE Claude subscription
 * pool instead of the new Agent-SDK programmatic-usage credit pool that
 * goes live 2026-06-15.
 *
 * Inputs (user prompts coming from the mobile app) are written into the
 * PTY's stdin. Outputs (assistant messages, tool calls, tool results) are
 * NOT parsed from the PTY's stdout — they're picked up from the canonical
 * Claude transcript at `~/.claude/projects/<cwd>/<sessionId>.jsonl` via
 * the existing sessionScanner. Tool-call permission decisions are routed
 * via the PreToolUse hook (see hookPermissionAdapter.ts).
 *
 * What the PTY child gives us:
 *   ┌────────────────────────────────────────┐
 *   │  PTY (claude interactive)              │
 *   │   ├ stdin ← keystrokes from happy-cli  │
 *   │   ├ stdout → (mostly ignored, we just  │
 *   │   │           detect lifecycle states) │
 *   │   ├ session jsonl on disk → scanner    │
 *   │   └ PreToolUse hook → happy-cli HTTP   │
 *   └────────────────────────────────────────┘
 *
 * The launcher (claudeRemotePtyLauncher) owns the surrounding state:
 * permission handler, message buffer, abort plumbing, and the Ink UI.
 */

import type { IPty } from 'node-pty';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { resolveClaudeBinary } from './utils/resolveClaudeBinary';
import { ensureLocalProxyBypass } from './utils/proxyBypass';
import { awaitFileExist } from '@/modules/watcher/awaitFileExist';
import { getProjectPath } from './utils/path';
import type { EnhancedMode } from './loop';
import { mapToClaudeMode } from './utils/permissionMode';
import { extractPtyStatusLine, ptyStatusLineHash, type PtyStatusLine } from './utils/ptyStatusLine';

export type PtyLifecycle = 'starting' | 'ready' | 'thinking' | 'idle' | 'exited';

export interface ClaudeRemotePtyOptions {
    /** Initial session id (if resuming). null for fresh session. */
    sessionId: string | null;
    /** Working directory (cwd for the spawned claude process). */
    path: string;
    /** Path to hook settings JSON injecting PreToolUse / Stop / SessionStart. */
    hookSettingsPath: string;
    /** MCP servers to load (forwarded via --mcp-config). */
    mcpServers?: Record<string, unknown>;
    /** Tools auto-allowed at the CLI level (forwarded via --allowedTools). */
    allowedTools: string[];
    /** Extra env vars to inject. */
    claudeEnvVars?: Record<string, string>;
    /** Extra CLI args passed through (e.g. --continue, --resume). */
    claudeArgs?: string[];
    /** PTY column count (default 200 — wide enough to avoid wrapping). */
    cols?: number;
    /** PTY row count (default 50). */
    rows?: number;
    /** Initial mode (permission mode, model, system prompt) */
    initialMode: EnhancedMode;
    /** Abort signal for the whole PTY session. */
    signal: AbortSignal;

    // Callbacks ------------------------------------------------------------
    /** Notified once the PTY is past the trust dialog / startup splash. */
    onReady?: () => void;
    /** Notified when claude shows signs of generating output ("thinking"). */
    onThinkingChange?: (thinking: boolean) => void;
    /** Notified when an unexpected PTY exit happens. */
    onExit?: (code: number | undefined, signal: string | null | undefined) => void;
    /** Notified when raw PTY bytes arrive — for diagnostics only. */
    onRawData?: (chunk: string) => void;
    /**
     * Notified when Claude's live status line (elapsed / tokens / effort
     * / current task title) changes. Already de-duplicated against the
     * previous emission via stable hash, so consumers can forward the
     * payload directly to the network with their own throttle.
     */
    onStatusLine?: (status: PtyStatusLine) => void;
}

export interface ClaudeRemotePty {
    /** Send a user message and submit it (Enter). Multi-line strings handled via paste-mode. */
    sendUserMessage: (text: string) => Promise<void>;
    /** Send Ctrl-C interrupt to claude (cancel current turn). */
    interrupt: () => void;
    /** Resize the PTY (if happy-cli's outer terminal resizes). */
    resize: (cols: number, rows: number) => void;
    /** Kill the child cleanly (SIGTERM + cleanup). */
    kill: () => Promise<void>;
    /** Whether the child has exited. */
    isAlive: () => boolean;
    /** Current lifecycle phase. */
    lifecycle: () => PtyLifecycle;
}

// Strip enough ANSI/CSI noise to make pattern detection robust across
// claude UI updates without dragging in a real ANSI parser.
function stripAnsi(s: string): string {
    return s
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
        .replace(/\x1b[=>]/g, '')
        .replace(/\x1b\(B/g, '')
        .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ');
}

/**
 * Spawn claude under a PTY and return a control surface.
 *
 * This is intentionally low-level: lifecycle management (when to push the
 * next message, when to mark "thinking", how to interpret jsonl messages)
 * lives in the launcher. Here we only deal with the OS-level wrangling.
 */
export async function startClaudeRemotePty(opts: ClaudeRemotePtyOptions): Promise<ClaudeRemotePty> {
    // node-pty is a heavy native dep we only need when the user actually
    // opts into PTY mode — keep it out of cold-start by importing lazily.
    // happy-cli ships as ESM, so dynamic import() (not require()) is the
    // portable way to defer the native binding load until needed.
    const ptyMod: typeof import('node-pty') = await import('node-pty');

    const claudeBin = await resolveClaudeBinary();
    if (!claudeBin) {
        throw new Error(
            'claude binary not found on PATH. Install with `curl -fsSL https://claude.ai/install.sh | bash` or `npm i -g @anthropic-ai/claude-code`.',
        );
    }

    // Build argv. We deliberately do NOT pass --print here — PTY mode is
    // the whole point: interactive claude bills against the subscription
    // pool, not the programmatic-usage credit pool.
    const args: string[] = [];

    // Resume session (if known up front).
    if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
    }

    // Permission mode — happy-cli's PTY default is bypassPermissions, on the
    // assumption that the user explicitly delegated authority to the mobile
    // app. The PreToolUse hook still fires, so any per-call deny/allow
    // decision the app sends back is honoured. bypassPermissions just means
    // claude won't synchronously block waiting for a y/n in the terminal.
    const permissionMode = mapToClaudeMode(opts.initialMode.permissionMode);
    if (permissionMode) {
        args.push('--permission-mode', permissionMode);
    }

    if (opts.initialMode.model) {
        args.push('--model', opts.initialMode.model);
    }
    if (opts.initialMode.appendSystemPrompt) {
        args.push('--append-system-prompt', opts.initialMode.appendSystemPrompt);
    } else if (opts.initialMode.customSystemPrompt) {
        args.push('--system-prompt', opts.initialMode.customSystemPrompt);
    }
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    }
    if (opts.allowedTools.length > 0) {
        args.push('--allowedTools', opts.allowedTools.join(','));
    }
    if (opts.initialMode.disallowedTools && opts.initialMode.disallowedTools.length > 0) {
        args.push('--disallowedTools', opts.initialMode.disallowedTools.join(','));
    }
    args.push('--settings', opts.hookSettingsPath);

    // Pass-through user-supplied args. We intentionally do not strip
    // --resume/--continue here because the user may legitimately want to
    // override our resume target.
    if (opts.claudeArgs && opts.claudeArgs.length > 0) {
        args.push(...opts.claudeArgs);
    }

    // Environment — start from process.env so the user's PATH / HOME /
    // credentials helpers are visible to claude, then layer our overrides.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v;
    }
    env.CLAUDE_CODE_ENTRYPOINT = 'remote_mobile';
    env.TERM = env.TERM && env.TERM.length > 0 ? env.TERM : 'xterm-256color';
    if (opts.claudeEnvVars) {
        for (const [k, v] of Object.entries(opts.claudeEnvVars)) env[k] = v;
    }
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        ensureLocalProxyBypass(env);
    }

    logger.debug(`[claudeRemotePty] spawning ${claudeBin} with args:`, args);

    const child: IPty = ptyMod.spawn(claudeBin, args, {
        name: 'xterm-256color',
        cols: opts.cols ?? 200,
        rows: opts.rows ?? 50,
        cwd: opts.path,
        env: env as { [key: string]: string },
    });

    let lifecycle: PtyLifecycle = 'starting';
    let exited = false;
    let scrollBuffer = '';
    let lastByteAt = Date.now();
    let lastReadyKickAt = 0;
    let trustAcknowledged = false;
    let lastStatusHash: string | null = null;

    function setLifecycle(next: PtyLifecycle) {
        if (lifecycle === next) return;
        lifecycle = next;
        logger.debug(`[claudeRemotePty] lifecycle → ${next}`);
        if (next === 'ready' || next === 'idle') {
            opts.onReady?.();
        }
    }

    function pushScroll(chunk: string) {
        // Keep buffer bounded — we only need the recent tail to recognise
        // UI states ("Yes, I trust", "Try \"...\"", etc).
        scrollBuffer = (scrollBuffer + chunk).slice(-8192);
        lastByteAt = Date.now();
    }

    child.onData((data) => {
        opts.onRawData?.(data);
        pushScroll(data);
        const clean = stripAnsi(scrollBuffer);
        // Claude renders its TUI by emitting CSI nC (cursor-forward) between
        // letters of long lines rather than literal spaces, so a stripped
        // buffer often looks like "YesItrustthisfolder" / "Tryforshortcuts".
        // We do BOTH a normal match against `clean` (covers single-column
        // copies, narrow renders, status bar etc) AND a no-whitespace match
        // against `compact` (covers the cursor-forward case).
        const compact = clean.replace(/\s+/g, '');

        // Trust-folder dialog — happens once on the first run in a new cwd.
        // Default highlighted option is "Yes, I trust this folder", so a
        // single Enter dismisses it.
        if (
            !trustAcknowledged &&
            (/Yes,\s+I\s+trust\s+this\s+folder/i.test(clean) ||
                /Yes,?Itrustthisfolder/i.test(compact))
        ) {
            logger.debug('[claudeRemotePty] trust-folder dialog detected → sending Enter');
            child.write('\r');
            trustAcknowledged = true;
            return;
        }

        // Detect main prompt readiness — claude draws either "Try \"...\""
        // or "? for shortcuts" in the bottom hint band when the chat box is
        // alive. We use this as our "ready" signal so the launcher knows
        // it's safe to start writing user messages.
        const readyHit =
            /(Try\s+"|for\s+shortcuts|\?\s+for\s+shortcuts)/i.test(clean) ||
            /Try"|forshortcuts|\?forshortcuts/i.test(compact);
        if (lifecycle === 'starting' && readyHit) {
            // Debounce: don't fire `ready` on every redraw.
            const now = Date.now();
            if (now - lastReadyKickAt > 500) {
                lastReadyKickAt = now;
                setLifecycle('ready');
            }
        }

        // Heuristic for thinking — if claude prints a "Working" / "esc to
        // interrupt" footer, mark thinking. When the footer disappears we
        // mark idle. We deliberately don't try to be too precise — the
        // real source of truth for "turn finished" is the Stop hook.
        const thinkingHit =
            /(Working|esc to interrupt|ctrl\+b to run in background)/i.test(clean) ||
            /esctointerrupt|ctrl\+btoruninbackground/i.test(compact);
        if (thinkingHit) {
            if (lifecycle !== 'thinking') {
                setLifecycle('thinking');
                opts.onThinkingChange?.(true);
            }
        }

        // Status-line scrape — only meaningful while thinking. Regex miss
        // is silent so a future Claude footer reformat degrades to the
        // thinking-boolean signal we already had.
        if (opts.onStatusLine && (thinkingHit || lifecycle === 'thinking')) {
            const status = extractPtyStatusLine(clean);
            if (status) {
                const hash = ptyStatusLineHash(status);
                if (hash !== lastStatusHash) {
                    lastStatusHash = hash;
                    opts.onStatusLine(status);
                }
            }
        }
    });

    child.onExit(({ exitCode, signal }) => {
        exited = true;
        setLifecycle('exited');
        opts.onThinkingChange?.(false);
        opts.onExit?.(exitCode, signal ? String(signal) : null);
        logger.debug(`[claudeRemotePty] child exited code=${exitCode} signal=${signal}`);
    });

    if (opts.signal.aborted) {
        try {
            child.kill();
        } catch {}
    } else {
        const onAbort = () => {
            try {
                child.kill();
            } catch {}
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Wait for the underlying jsonl file when resuming so the scanner has
    // something to watch right away. Best-effort — if the file never
    // shows up we still return; the scanner has a polling fallback.
    if (opts.sessionId) {
        const projectDir = getProjectPath(opts.path);
        const jsonlPath = join(projectDir, `${opts.sessionId}.jsonl`);
        awaitFileExist(jsonlPath).catch(() => {
            /* ignore — file watcher tolerates absence */
        });
    }

    // Periodic idle detection: if we go more than 1.2s without bytes AND
    // we're currently 'thinking', flip back to 'idle' so the UI updates.
    // The Stop hook is the authoritative signal for "turn finished" — this
    // is just a cosmetic spinner-killer.
    const idleTimer = setInterval(() => {
        if (exited) return;
        if (lifecycle === 'thinking' && Date.now() - lastByteAt > 1200) {
            setLifecycle('idle');
            opts.onThinkingChange?.(false);
        }
    }, 600).unref();

    /**
     * Write a user prompt into the PTY using bracketed-paste mode so claude
     * doesn't interpret leading slashes / mentions as live keystroke
     * commands. Closes with Enter so claude submits.
     */
    async function sendUserMessage(text: string): Promise<void> {
        if (exited) {
            throw new Error('claudeRemotePty: child has exited');
        }
        // Block submission until claude is actually ready, otherwise the
        // first few chars get eaten by the splash/trust UI.
        await waitForReady(child);

        // Bracketed paste: ESC [ 2 0 0 ~  <text>  ESC [ 2 0 1 ~
        const START = '\x1b[200~';
        const END = '\x1b[201~';
        // Convert lone \n to \r so claude's editor inserts a soft newline
        // (Shift-Enter in the TUI) rather than submitting prematurely.
        const normalised = text.replace(/\r\n|\n/g, '\r');
        child.write(START + normalised + END);
        // Submit
        child.write('\r');

        setLifecycle('thinking');
        opts.onThinkingChange?.(true);
    }

    function waitForReady(_child: IPty): Promise<void> {
        if (lifecycle === 'ready' || lifecycle === 'idle' || lifecycle === 'thinking') {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const t = setInterval(() => {
                if (
                    lifecycle === 'ready' ||
                    lifecycle === 'idle' ||
                    lifecycle === 'thinking'
                ) {
                    clearInterval(t);
                    resolve();
                    return;
                }
                if (exited) {
                    clearInterval(t);
                    reject(new Error('claudeRemotePty: child exited before becoming ready'));
                    return;
                }
                if (Date.now() - start > 30_000) {
                    clearInterval(t);
                    reject(new Error('claudeRemotePty: timed out waiting for ready'));
                }
            }, 100);
        });
    }

    function interrupt(): void {
        if (exited) return;
        child.write('\x03'); // Ctrl-C
    }

    function resize(cols: number, rows: number): void {
        if (exited) return;
        try {
            child.resize(cols, rows);
        } catch (err) {
            logger.debug('[claudeRemotePty] resize failed:', err);
        }
    }

    async function kill(): Promise<void> {
        if (exited) return;
        try {
            child.kill('SIGTERM');
        } catch {}
        // Give claude a moment for a graceful shutdown, then SIGKILL.
        await new Promise((r) => setTimeout(r, 250));
        if (!exited) {
            try {
                child.kill('SIGKILL');
            } catch {}
        }
        clearInterval(idleTimer);
    }

    return {
        sendUserMessage,
        interrupt,
        resize,
        kill,
        isAlive: () => !exited,
        lifecycle: () => lifecycle,
    };
}
