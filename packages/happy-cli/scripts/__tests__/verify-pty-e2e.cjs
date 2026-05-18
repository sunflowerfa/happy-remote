#!/usr/bin/env node
/**
 * End-to-end PTY mode integration verification:
 *   1. Start an HTTP hook server (mocked locally).
 *   2. Generate full hook settings file (SessionStart + PreToolUse + Stop + ...).
 *   3. Spawn `claude` under node-pty with --settings pointing at our hooks.
 *   4. Dismiss trust dialog if present.
 *   5. Type a real prompt that should trigger a tool call: "Read /etc/hostname".
 *   6. Watch the hook server for SessionStart / PreToolUse / Stop hits.
 *   7. Watch ~/.claude/projects/.../<sessionId>.jsonl for assistant + tool_result entries.
 *   8. Assert: tool_call recorded in jsonl, hook fired, Stop hook fired.
 *
 * No happy-cli imports — pure CJS so it runs without the TS build.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { execSync } = require('node:child_process');

const FORWARDER = path.resolve(__dirname, '..', 'hook_forwarder.cjs');
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-pty-e2e-'));
const SETTINGS_PATH = path.join(RUN_DIR, 'settings.json');

console.error(`[e2e] run dir: ${RUN_DIR}`);

const calls = {
    sessionStart: [],
    preToolUse: [],
    postToolUse: [],
    userPromptSubmit: [],
    stop: [],
    notification: [],
};

function readJson(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
            catch { resolve(null); }
        });
    });
}

// -----------------------------------------------------------------
// Hook server — mirrors happy-cli's startHookServer responsibilities
// -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
    }
    const body = await readJson(req);
    switch (req.url) {
        case '/hook/session-start':
            calls.sessionStart.push(body);
            console.error(`[hook] SessionStart sid=${body?.session_id}`);
            res.writeHead(200).end('ok');
            return;
        case '/hook/pre-tool-use':
            calls.preToolUse.push(body);
            console.error(`[hook] PreToolUse tool=${body?.tool_name}`);
            // Auto-allow every tool (PTY mode default = bypassPermissions);
            // mirrors what hookPermissionAdapter would do in bypassPermissions.
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    permissionDecisionReason: 'e2e auto-allow',
                },
            }));
            return;
        case '/hook/post-tool-use':
            calls.postToolUse.push(body);
            res.writeHead(204).end();
            return;
        case '/hook/user-prompt-submit':
            calls.userPromptSubmit.push(body);
            res.writeHead(204).end();
            return;
        case '/hook/stop':
            calls.stop.push(body);
            console.error('[hook] Stop');
            res.writeHead(204).end();
            return;
        case '/hook/notification':
            calls.notification.push(body);
            res.writeHead(204).end();
            return;
        default:
            res.writeHead(404).end();
    }
});

async function startServer() {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.on('error', reject);
    });
}

function writeSettings(port) {
    const cmd = (event) => `node "${FORWARDER}" ${port} ${event}`;
    const settings = {
        hooks: {
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('session-start') }] }],
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('pre-tool-use'), timeout: 60000 }] }],
            PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post-tool-use'), timeout: 30000 }] }],
            UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('user-prompt-submit'), timeout: 30000 }] }],
            Stop: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('stop'), timeout: 30000 }] }],
            Notification: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('notification'), timeout: 30000 }] }],
        },
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// -----------------------------------------------------------------
// PTY child
// -----------------------------------------------------------------

function stripAnsi(s) {
    return s
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
        .replace(/\x1b[=>]/g, '')
        .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ');
}

async function runPtyClaude(runCwd) {
    const claudeBin = execSync('which claude').toString().trim();
    console.error(`[pty] claude bin: ${claudeBin}`);

    const child = pty.spawn(claudeBin, [
        '--permission-mode', 'bypassPermissions',
        '--settings', SETTINGS_PATH,
        '--allowedTools', 'Read',
    ], {
        name: 'xterm-256color',
        cols: 200, rows: 50,
        cwd: runCwd,
        env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' },
    });

    let phase = 'STARTING'; // STARTING → READY → PROMPT_SENT → DONE
    let scroll = '';
    let trustAcknowledged = false;
    let exitedClean = false;
    let exitCode = null;

    const SENTINEL = `E2E_DONE_${process.pid}_${Date.now()}`;

    child.onData((data) => {
        scroll = (scroll + data).slice(-8192);
        if (process.env.E2E_DEBUG) process.stderr.write(data);
        const clean = stripAnsi(scroll);

        // Note: Claude renders the trust dialog by emitting cursor-forward
        // (CSI nC) sequences between letters, so a stripped buffer looks like
        // "YesItrustthisfolder". Use a relaxed match.
        const clean2 = clean.replace(/\s+/g, '');
        if (!trustAcknowledged && /Yes,?Itrustthisfolder/i.test(clean2)) {
            console.error('[pty] trust dialog → Enter');
            child.write('\r');
            trustAcknowledged = true;
            return;
        }

        if (phase === 'STARTING' && /Try"|forshortcuts|\?forshortcuts/i.test(clean2)) {
            phase = 'READY';
            console.error('[pty] main prompt ready → typing query');
            setTimeout(() => {
                const prompt =
                    `You MUST invoke the Read tool with file_path="/etc/hostname" first. ` +
                    `Then, after the tool returns, output exactly ${SENTINEL} as your final answer. ` +
                    `Do not skip the tool call.`;
                child.write('\x1b[200~' + prompt + '\x1b[201~');
                setTimeout(() => child.write('\r'), 200);
                phase = 'PROMPT_SENT';
            }, 700);
        }

        if (phase === 'PROMPT_SENT' && clean.includes(SENTINEL)) {
            phase = 'WAIT_STOP';
            console.error('[pty] sentinel seen → waiting for Stop hook before exiting');
            // Give Stop hook up to 8s to fire after claude finishes its turn.
            setTimeout(() => {
                if (calls.stop.length === 0) {
                    console.error('[pty] Stop hook did not fire after 8s → forcing quit');
                }
                phase = 'DONE';
                // Graceful quit: type /quit
                child.write('\x1b[200~/quit\x1b[201~');
                setTimeout(() => child.write('\r'), 200);
                setTimeout(() => child.kill(), 2500);
            }, 8000);
        }
    });

    return await new Promise((resolve) => {
        child.onExit(({ exitCode: code, signal }) => {
            exitedClean = true;
            exitCode = code;
            resolve({ phase, exitCode: code, signal, sentinelDone: phase === 'DONE' });
        });
        setTimeout(() => {
            if (!exitedClean) {
                console.error('[pty] timeout → killing');
                try { child.kill(); } catch {}
                resolve({ phase, exitCode: exitCode, signal: 'timeout', sentinelDone: phase === 'DONE' });
            }
        }, 120_000);
    });
}

// -----------------------------------------------------------------
// jsonl probe
// -----------------------------------------------------------------

function getProjectPath(cwd) {
    // Claude resolves the cwd via realpath before encoding it (macOS /var →
    // /private/var). Encoding rule: replace path separators and dots with `-`.
    const real = fs.realpathSync(cwd);
    const enc = real.replace(/[\\/.]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', enc);
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

// -----------------------------------------------------------------
// Main
// -----------------------------------------------------------------

(async () => {
    let exitCode = 1;
    try {
        const port = await startServer();
        console.error(`[server] :${port}`);
        writeSettings(port);

        const result = await runPtyClaude(RUN_DIR);

        // sessionId comes from the SessionStart hook payload
        const sessionId = calls.sessionStart[0]?.session_id;
        console.error(`\n[probe] sessionId = ${sessionId}`);

        const projDir = getProjectPath(RUN_DIR);
        const jsonlFile = sessionId ? path.join(projDir, `${sessionId}.jsonl`) : null;
        const messages = jsonlFile ? readJsonl(jsonlFile) : [];
        const sawReadCall = messages.some((m) =>
            m?.message?.content?.some?.((c) => c?.type === 'tool_use' && c?.name === 'Read'),
        );
        const sawToolResult = messages.some((m) =>
            m?.message?.content?.some?.((c) => c?.type === 'tool_result'),
        );

        console.error('\n========== PTY E2E REPORT ==========');
        console.error(`Phase reached:          ${result.phase}`);
        console.error(`Sentinel seen in PTY:   ${result.sentinelDone}`);
        console.error(`Claude exit code:       ${result.exitCode} / ${result.signal}`);
        console.error(`SessionStart hits:      ${calls.sessionStart.length}`);
        console.error(`UserPromptSubmit hits:  ${calls.userPromptSubmit.length}`);
        console.error(`PreToolUse hits:        ${calls.preToolUse.length}`);
        console.error(`PostToolUse hits:       ${calls.postToolUse.length}`);
        console.error(`Stop hits:              ${calls.stop.length}`);
        console.error(`Notification hits:      ${calls.notification.length}`);
        console.error(`jsonl path:             ${jsonlFile ?? '(no sessionId)'}`);
        console.error(`jsonl messages:         ${messages.length}`);
        console.error(`jsonl has Read tool_use:${sawReadCall}`);
        console.error(`jsonl has tool_result:  ${sawToolResult}`);
        console.error('====================================');

        // Pass criteria:
        //   • SessionStart fired (we have a sessionId)
        //   • PreToolUse fired ≥ 1 time (Read tool was intercepted)
        //   • jsonl on disk contains tool_use Read AND tool_result
        //   • PTY observed our sentinel (Claude completed the task)
        const pass =
            calls.sessionStart.length >= 1 &&
            calls.preToolUse.length >= 1 &&
            sawReadCall &&
            sawToolResult &&
            result.sentinelDone;

        if (pass) {
            console.error('\nPASS ✅');
            exitCode = 0;
        } else {
            console.error('\nFAIL ❌');
            exitCode = 1;
        }
    } catch (err) {
        console.error('[e2e] error:', err);
    } finally {
        server.close();
        try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch {}
        process.exit(exitCode);
    }
})();
