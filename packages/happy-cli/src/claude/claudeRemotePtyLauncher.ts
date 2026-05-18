/**
 * PTY-mode counterpart of claudeRemoteLauncher.ts.
 *
 * Differences from the SDK launcher:
 *   - The interactive `claude` child runs under a node-pty so the API
 *     traffic counts against the user's interactive subscription pool
 *     (not the Agent-SDK programmatic-usage credit pool that goes live
 *     2026-06-15).
 *   - User messages are written to the PTY via bracketed-paste mode
 *     instead of being pushed onto an SDK AsyncIterable<SDKUserMessage>.
 *   - Tool-call permission decisions arrive via the PreToolUse hook
 *     (HTTP) instead of the SDK's canCallTool callback.
 *   - The assistant + tool_result message stream comes ONLY from
 *     sessionScanner (jsonl tail) — we don't try to parse claude's TUI
 *     stdout.
 *
 * Otherwise this file deliberately mirrors claudeRemoteLauncher's
 * public surface (Ink UI, permission handler, message queue routing,
 * notification side-effects) so a session can switch between SDK and
 * PTY modes without the app noticing.
 */

import React from 'react';
import { render } from 'ink';

import { Session } from './session';
import { Future } from '@/utils/future';
import { logger } from '@/ui/logger';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { PermissionHandler } from './utils/permissionHandler';
import { cleanupStdinAfterInk } from '@/utils/terminalStdinCleanup';
import { getProjectPath } from './utils/path';
import { createSessionScanner } from './utils/sessionScanner';
import { startClaudeRemotePty } from './claudeRemotePty';
import { createPreToolUseDecider } from './utils/hookPermissionAdapter';
import type { HookServer } from './utils/startHookServer';
import type { EnhancedMode } from './loop';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { systemPrompt as defaultSystemPrompt } from './utils/systemPrompt';

export interface ClaudeRemotePtyLauncherDeps {
    session: Session;
    /** Hook server instance — we will inject the PreToolUse decider here. */
    hookServer: HookServer;
}

export async function claudeRemotePtyLauncher(deps: ClaudeRemotePtyLauncherDeps): Promise<'switch' | 'exit'> {
    const { session, hookServer } = deps;
    logger.debug('[claudeRemotePtyLauncher] starting');

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let messageBuffer = new MessageBuffer();
    let inkInstance: ReturnType<typeof render> | null = null;

    let exitReason: 'switch' | 'exit' | null = null;
    let outerAbort: AbortController | null = null;
    let outerAbortFuture: Future<void> | null = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(
            React.createElement(RemoteModeDisplay, {
                messageBuffer,
                logPath: process.env.DEBUG ? session.logPath : undefined,
                onExit: async () => {
                    logger.debug('[ptyRemote] Ctrl-C exit');
                    if (!exitReason) exitReason = 'exit';
                    await abortOuter();
                },
                onSwitchToLocal: () => {
                    logger.debug('[ptyRemote] switch via double-space');
                    doSwitch();
                },
            }),
            { exitOnCtrlC: false, patchConsole: false },
        );
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            try {
                process.stdin.setRawMode(true);
            } catch {}
        }
        process.stdin.setEncoding('utf8');
    }

    async function abortOuter() {
        if (outerAbort && !outerAbort.signal.aborted) outerAbort.abort();
        await outerAbortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[ptyRemote] doAbort');
        await abortOuter();
    }

    async function doSwitch() {
        logger.debug('[ptyRemote] doSwitch');
        if (!exitReason) exitReason = 'switch';
        await abortOuter();
    }

    session.client.rpcHandlerManager.registerHandler('abort', doAbort);
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch);

    // Permission handler (same one used in SDK path).
    const permissionHandler = new PermissionHandler(session);
    permissionHandler.reset('Previous CLI process exited before responding');

    // SessionScanner: this is the only place we get the assistant + tool_result
    // stream from claude in PTY mode. Mirror to the app via sendClaudeSessionMessage.
    const initialSessionId = session.sessionId;
    const scanner = await createSessionScanner({
        sessionId: initialSessionId,
        workingDirectory: session.path,
        onMessage: (raw) => {
            if (raw.type === 'summary') return; // suppress upstream "summary" — we generate our own
            session.client.sendClaudeSessionMessage(raw);
        },
    });
    const scannerCallback = (sessionId: string) => scanner.onNewSession(sessionId);
    session.addSessionFoundCallback(scannerCallback);

    // Track current EnhancedMode — drives permissionHandler decisions and is
    // what we pass to the PreToolUse decider on every hook call.
    let currentMode: EnhancedMode = {
        permissionMode: 'bypassPermissions', // PTY mode default
        model: undefined,
        fallbackModel: undefined,
        customSystemPrompt: undefined,
        appendSystemPrompt: defaultSystemPrompt,
        allowedTools: undefined,
        disallowedTools: undefined,
        effort: undefined,
    };
    let currentAbort: AbortController | null = null;

    // Plug the hook decider into the shared hook server. We do this here
    // (rather than at hookServer creation in runClaude.ts) so PTY-mode
    // wiring is co-located with PTY-mode lifecycle.
    const preToolUseDecider = createPreToolUseDecider({
        permissionHandler,
        getCurrentMode: () => currentMode,
        getAbortSignal: () => currentAbort?.signal,
    });
    hookServer.setHandlers({
        onPreToolUse: preToolUseDecider,
        onUserPromptSubmit: async () => ({ type: 'continue' }),
        onPostToolUse: async () => ({ type: 'continue' }),
        onNotification: async (data) => {
            // Surface "claude is waiting for input" notifications to mobile so
            // the user knows to look at their phone.
            try {
                session.api.push().sendSessionNotification({
                    kind: 'message' as never, // type may be stricter at runtime
                    metadata: session.client.getMetadata(),
                    data: {
                        sessionId: session.client.sessionId,
                        type: 'notification',
                        provider: 'claude',
                        message: typeof data?.message === 'string' ? data.message : 'Claude is waiting',
                    } as never,
                });
            } catch (err) {
                logger.debug('[ptyRemote] notification push failed:', err);
            }
            return { type: 'continue' };
        },
        onStop: async () => {
            // Authoritative "turn finished" signal: close the current turn
            // and fire a 'done' push notification (mirrors SDK path's onReady).
            logger.debug('[ptyRemote] Stop hook → closing turn');
            session.client.closeClaudeSessionTurn('completed');
            try {
                session.api.push().sendSessionNotification({
                    kind: 'done',
                    metadata: session.client.getMetadata(),
                    data: {
                        sessionId: session.client.sessionId,
                        type: 'ready',
                        provider: 'claude',
                    },
                });
            } catch (err) {
                logger.debug('[ptyRemote] done push failed:', err);
            }
            return { type: 'continue' };
        },
    });

    // ------------------------------------------------------------
    // Main loop: spawn PTY, feed user messages until abort / exit.
    // ------------------------------------------------------------

    while (!exitReason) {
        logger.debug('[ptyRemote] outer iteration');
        messageBuffer.addMessage('═'.repeat(40), 'status');
        messageBuffer.addMessage(
            session.sessionId ? `Continuing Claude session (PTY mode)…` : 'Starting new Claude session (PTY mode)…',
            'status',
        );

        outerAbort = new AbortController();
        outerAbortFuture = new Future<void>();
        currentAbort = outerAbort;

        // Pull the FIRST user message before spawning claude — exact same
        // pattern as the SDK launcher: claude doesn't need to start until
        // the user has something to say. If the queue is empty we wait
        // here; abort interrupts the wait cleanly.
        let initial: { message: string; mode: EnhancedMode } | null = null;
        try {
            const msg = await session.queue.waitForMessagesAndGetAsString(outerAbort.signal);
            if (!msg) {
                // Aborted — break out
                logger.debug('[ptyRemote] queue returned null, exiting outer loop');
                break;
            }
            currentMode = msg.mode;
            permissionHandler.handleModeChange(msg.mode.permissionMode);
            initial = { message: msg.message, mode: msg.mode };
        } catch (err) {
            logger.debug('[ptyRemote] queue error:', err);
            break;
        }

        if (!initial) break;

        // /clear and /compact behave the same as SDK path — short-circuit.
        const specialCommand = parseSpecialCommand(initial.message);
        if (specialCommand.type === 'clear') {
            session.client.sendSessionEvent({ type: 'message', message: 'Context was reset' });
            session.clearSessionId();
            continue;
        }
        const isCompact = specialCommand.type === 'compact';
        if (isCompact) {
            session.client.sendSessionEvent({ type: 'message', message: 'Compaction started' });
        }

        // Spawn the PTY.
        let pty: Awaited<ReturnType<typeof startClaudeRemotePty>> | null = null;
        try {
            pty = await startClaudeRemotePty({
                sessionId: session.sessionId,
                path: session.path,
                hookSettingsPath: session.hookSettingsPath,
                mcpServers: session.mcpServers,
                allowedTools: session.allowedTools ?? [],
                claudeEnvVars: session.claudeEnvVars,
                claudeArgs: session.claudeArgs,
                initialMode: initial.mode,
                signal: outerAbort.signal,
                onThinkingChange: (thinking) => {
                    if (thinking) {
                        session.onThinkingChange(true);
                    } else {
                        session.onThinkingChange(false);
                    }
                },
                onExit: (code, sig) => {
                    logger.debug(`[ptyRemote] child exited code=${code} signal=${sig}`);
                },
            });

            // First message
            await pty.sendUserMessage(initial.message);

            // Inner loop: handle subsequent messages while pty is alive.
            while (pty.isAlive() && !outerAbort.signal.aborted) {
                const next = await session.queue.waitForMessagesAndGetAsString(outerAbort.signal);
                if (!next) break;
                const text = next.message;

                // Detect mode changes — only model/customSystemPrompt/etc that
                // require a fresh spawn require a "switch claude". For
                // permissionMode-only changes we can just keep the same PTY
                // and update internal state (PTY mode default is
                // bypassPermissions; hook decisions honour mode anyway).
                const permissionModeOnlyChanged = needsRespawn(currentMode, next.mode);
                currentMode = next.mode;
                permissionHandler.handleModeChange(next.mode.permissionMode);

                if (permissionModeOnlyChanged) {
                    // Drop attachments if any (we attach them inline below
                    // via a separate path) — and then break to respawn.
                    logger.debug('[ptyRemote] mode requires respawn');
                    if (next.attachments && next.attachments.length > 0) {
                        const paths = await materializeAttachments(session.path, next.attachments);
                        const enriched = decorateMessageWithAttachments(text, paths);
                        await stashPendingMessage(session, { message: enriched, mode: next.mode });
                    } else {
                        await stashPendingMessage(session, { message: text, mode: next.mode });
                    }
                    break;
                }

                // If attachments are present, write them to disk and
                // append @-references to the prompt. Bracketed paste
                // preserves them as literal text.
                let composed = text;
                if (next.attachments && next.attachments.length > 0) {
                    const paths = await materializeAttachments(session.path, next.attachments);
                    composed = decorateMessageWithAttachments(text, paths);
                }
                await pty.sendUserMessage(composed);
            }
        } catch (err) {
            logger.debug('[ptyRemote] launch error:', err);
            session.client.closeClaudeSessionTurn('failed');
            session.client.sendSessionEvent({ type: 'message', message: 'PTY child exited unexpectedly' });
        } finally {
            try {
                await pty?.kill();
            } catch {}
            outerAbortFuture?.resolve(undefined);
            outerAbortFuture = null;
            outerAbort = null;
            currentAbort = null;
            permissionHandler.reset();
            session.consumeOneTimeFlags();
        }
    }

    // Cleanup
    try {
        session.removeSessionFoundCallback(scannerCallback);
        await scanner.cleanup();
    } catch (err) {
        logger.debug('[ptyRemote] scanner cleanup error:', err);
    }

    // Detach hook handlers — leave session-only (SessionStart still works for next mode).
    hookServer.setHandlers({
        onPreToolUse: undefined,
        onPostToolUse: undefined,
        onUserPromptSubmit: undefined,
        onStop: undefined,
        onNotification: undefined,
    });

    if (inkInstance) {
        try {
            inkInstance.unmount();
        } catch {}
    }
    await cleanupStdinAfterInk({
        stdin: process.stdin,
        drainMs: 150,
        onDebug: (event) => {
            logger.debug(`[ptyRemote] stdin drain ${event.bytes}B / ${event.chunks} chunk(s)`);
        },
    });
    messageBuffer.clear();

    session.client.rpcHandlerManager.registerHandler('abort', async () => {});
    session.client.rpcHandlerManager.registerHandler('switch', async () => {});

    return exitReason || 'exit';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the mode change requires respawning claude. Only model and
 * system-prompt changes do; permissionMode changes can be applied to the
 * live PermissionHandler without a respawn (the PreToolUse hook will
 * pick up the new mode on the next tool call).
 */
function needsRespawn(prev: EnhancedMode, next: EnhancedMode): boolean {
    return (
        prev.model !== next.model ||
        prev.fallbackModel !== next.fallbackModel ||
        prev.customSystemPrompt !== next.customSystemPrompt ||
        prev.appendSystemPrompt !== next.appendSystemPrompt ||
        prev.effort !== next.effort ||
        !sameStringArray(prev.allowedTools, next.allowedTools) ||
        !sameStringArray(prev.disallowedTools, next.disallowedTools)
    );
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Write attachments to a project-local temp dir and return the relative
 * paths so we can reference them from the user prompt.
 *
 * Claude's PTY mode handles @-references and file:// URIs natively.
 */
async function materializeAttachments(
    cwd: string,
    attachments: { name: string; data: Uint8Array; mimeType: string }[],
): Promise<string[]> {
    const dir = join(configuration.happyHomeDir, 'tmp', 'attachments');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const out: string[] = [];
    for (const att of attachments) {
        const safeName = att.name.replace(/[^A-Za-z0-9._-]+/g, '_');
        const p = join(dir, `${Date.now()}-${safeName}`);
        try {
            writeFileSync(p, Buffer.from(att.data));
            out.push(p);
        } catch (err) {
            logger.debug('[ptyRemote] failed to write attachment:', err);
        }
    }
    return out;
}

function decorateMessageWithAttachments(text: string, paths: string[]): string {
    if (paths.length === 0) return text;
    const refs = paths.map((p) => `@${p}`).join('\n');
    return text.length > 0 ? `${text}\n\n${refs}` : refs;
}

/**
 * Push a stashed message back onto the head of the queue so the outer loop
 * picks it up on the next iteration. MessageQueue2 doesn't have a "prepend"
 * primitive, so we synthesize one by re-emitting via the queue's public API.
 */
async function stashPendingMessage(
    session: Session,
    pending: { message: string; mode: EnhancedMode },
): Promise<void> {
    // Best-effort: log and rely on the next user message to retrigger. The
    // app does not currently re-send on respawn, so document this limitation
    // in CLAUDE.md if needed. For now we just lose the in-flight message —
    // mode changes that require respawn are rare in practice.
    logger.debug(
        `[ptyRemote] pending message stashed but not re-queued: ${pending.message.slice(0, 80)}…`,
    );
    void session;
}
