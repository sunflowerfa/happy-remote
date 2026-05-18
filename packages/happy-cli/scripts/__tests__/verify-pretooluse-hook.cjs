#!/usr/bin/env node
/**
 * Standalone verification: can a PreToolUse hook intercept tool calls?
 *
 * This script does NOT depend on happy-cli's TS build — it's pure CJS,
 * runnable as `node verify-pretooluse-hook.cjs`.
 *
 * Test plan:
 *   1. Start a tiny HTTP server that the hook forwarder will POST to.
 *   2. Register PreToolUse decision callback that DENIES every tool call.
 *   3. Generate a hook settings JSON pointing to scripts/hook_forwarder.cjs.
 *   4. Run `claude --print --permission-mode bypassPermissions \
 *           --settings <path> "Use the Read tool to read /etc/hostname"`.
 *   5. Assert: PreToolUse was invoked AND Claude reports the denial.
 *
 * We're using `claude --print` here only to keep the test single-shot;
 * the production code path will use interactive `claude` over PTY where
 * the same hook config is reused.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FORWARDER = path.resolve(__dirname, '..', 'hook_forwarder.cjs');
const HAPPY_TMP = path.join(os.tmpdir(), `happy-hook-verify-${process.pid}`);
fs.mkdirSync(HAPPY_TMP, { recursive: true });

const SETTINGS_PATH = path.join(HAPPY_TMP, 'settings.json');

// --------------------------------------------------------------------
// 1. Start mock hook server
// --------------------------------------------------------------------

const calls = {
    preToolUse: [],
    sessionStart: [],
    postToolUse: [],
    stop: [],
    userPromptSubmit: [],
};

function readJson(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch {
                resolve(null);
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
    }
    const body = await readJson(req);
    switch (req.url) {
        case '/hook/session-start':
            calls.sessionStart.push(body);
            console.error(`[mock-server] SessionStart sessionId=${body?.session_id}`);
            res.writeHead(200).end('ok');
            return;
        case '/hook/pre-tool-use': {
            calls.preToolUse.push(body);
            console.error(
                `[mock-server] PreToolUse tool=${body?.tool_name} input=${JSON.stringify(body?.tool_input)}`,
            );
            // Deny EVERY tool call. Claude docs: hookSpecificOutput with
            // permissionDecision='deny' + permissionDecisionReason.
            const denyBody = JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason:
                        'TEST_DENY_REASON: blocked by verify-pretooluse-hook.cjs',
                },
            });
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(denyBody);
            return;
        }
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
            console.error('[mock-server] Stop');
            res.writeHead(204).end();
            return;
        default:
            res.writeHead(404).end();
    }
});

async function startServer() {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            console.error(`[mock-server] listening on 127.0.0.1:${port}`);
            resolve(port);
        });
        server.on('error', reject);
    });
}

// --------------------------------------------------------------------
// 2. Settings.json — full hook profile pointing at our forwarder
// --------------------------------------------------------------------

function writeSettings(port) {
    const cmd = (event) => `node "${FORWARDER}" ${port} ${event}`;
    const settings = {
        hooks: {
            SessionStart: [
                { matcher: '*', hooks: [{ type: 'command', command: cmd('session-start') }] },
            ],
            PreToolUse: [
                {
                    matcher: '*',
                    hooks: [{ type: 'command', command: cmd('pre-tool-use'), timeout: 60_000 }],
                },
            ],
            PostToolUse: [
                {
                    matcher: '*',
                    hooks: [{ type: 'command', command: cmd('post-tool-use'), timeout: 30_000 }],
                },
            ],
            UserPromptSubmit: [
                {
                    matcher: '*',
                    hooks: [
                        { type: 'command', command: cmd('user-prompt-submit'), timeout: 30_000 },
                    ],
                },
            ],
            Stop: [
                { matcher: '*', hooks: [{ type: 'command', command: cmd('stop'), timeout: 30_000 }] },
            ],
        },
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.error(`[verify] wrote settings: ${SETTINGS_PATH}`);
}

// --------------------------------------------------------------------
// 3. Run claude --print
// --------------------------------------------------------------------

function runClaude() {
    return new Promise((resolve) => {
        const prompt =
            'Use the Read tool to read the file /etc/hostname. Then tell me what you found.';
        const args = [
            '--print',
            '--permission-mode',
            'bypassPermissions',
            '--settings',
            SETTINGS_PATH,
            '--allowedTools',
            'Read',
        ];

        console.error(`[verify] spawning: claude ${args.join(' ')}  (prompt via stdin)`);
        const child = spawn('claude', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                CLAUDE_CODE_ENTRYPOINT: 'remote_mobile',
            },
        });

        child.stdin.write(prompt);
        child.stdin.end();

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => {
            stdout += c.toString();
            process.stdout.write(c);
        });
        child.stderr.on('data', (c) => {
            stderr += c.toString();
            process.stderr.write(c);
        });
        child.on('exit', (code) => {
            console.error(`\n[verify] claude exited with code=${code}`);
            resolve({ code, stdout, stderr });
        });
    });
}

// --------------------------------------------------------------------
// 4. Run + report
// --------------------------------------------------------------------

(async () => {
    let exitCode = 1;
    try {
        const port = await startServer();
        writeSettings(port);
        const result = await runClaude();

        console.error('\n========== VERIFICATION REPORT ==========');
        console.error(`Forwarder script:   ${FORWARDER}`);
        console.error(`Settings path:      ${SETTINGS_PATH}`);
        console.error(`Claude exit code:   ${result.code}`);
        console.error(`SessionStart hits:  ${calls.sessionStart.length}`);
        console.error(`UserPromptSubmit:   ${calls.userPromptSubmit.length}`);
        console.error(`PreToolUse hits:    ${calls.preToolUse.length}`);
        console.error(`PostToolUse hits:   ${calls.postToolUse.length}`);
        console.error(`Stop hits:          ${calls.stop.length}`);
        console.error('-----------------------------------------');

        const preCount = calls.preToolUse.length;
        // Claude may surface the deny reason in many ways/languages; match either
        // the verbatim reason text or common "intercepted/blocked/denied" verbs.
        const claudeMentionedDeny =
            /TEST_DENY_REASON|denied|blocked|intercept|拦截|阻止|被钩子/i.test(
                result.stdout + result.stderr,
            );

        if (preCount > 0 && claudeMentionedDeny) {
            console.error('PASS: PreToolUse hook fired AND Claude received the deny reason.');
            exitCode = 0;
        } else if (preCount > 0 && !claudeMentionedDeny) {
            console.error(
                'PARTIAL: PreToolUse fired but Claude did not surface the deny reason in stdout/stderr.',
            );
            console.error('  → The hook IS intercepting, but the deny payload may have a different shape.');
            exitCode = 2;
        } else {
            console.error('FAIL: PreToolUse hook never fired.');
            exitCode = 3;
        }
        console.error('=========================================\n');
    } catch (err) {
        console.error('[verify] error:', err);
    } finally {
        server.close();
        try {
            fs.rmSync(HAPPY_TMP, { recursive: true, force: true });
        } catch {}
        process.exit(exitCode);
    }
})();
