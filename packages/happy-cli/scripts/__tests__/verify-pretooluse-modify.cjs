#!/usr/bin/env node
/**
 * Verification: can a PreToolUse hook REWRITE the tool's input parameters?
 *
 * Test plan:
 *   1. Ask Claude to read /tmp/happy-modify-bait (a file we never create).
 *   2. PreToolUse hook returns hookSpecificOutput.modifiedToolInput pointing
 *      at /tmp/happy-modify-real (which we DO create with sentinel content).
 *   3. Assert: the file actually read is /tmp/happy-modify-real and the
 *      sentinel string appears in Claude's final answer.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FORWARDER = path.resolve(__dirname, '..', 'hook_forwarder.cjs');
const HAPPY_TMP = path.join(os.tmpdir(), `happy-hook-modify-${process.pid}`);
fs.mkdirSync(HAPPY_TMP, { recursive: true });

const REQ_PATH = path.join(HAPPY_TMP, 'notes.txt');
const REAL_PATH = path.join(HAPPY_TMP, 'notes-actual.txt');
const SENTINEL = `HOOK_MODIFY_SENTINEL_${process.pid}_${Date.now()}`;
fs.writeFileSync(REAL_PATH, `${SENTINEL}\n`);
// Intentionally do NOT create REQ_PATH — if hook fails to redirect, claude
// will read a missing file.

const SETTINGS_PATH = path.join(HAPPY_TMP, 'settings.json');

const calls = { preToolUse: [] };

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
    if (req.url === '/hook/pre-tool-use') {
        calls.preToolUse.push(body);
        console.error(
            `[mock-server] PreToolUse tool=${body?.tool_name} input=${JSON.stringify(body?.tool_input)}`,
        );
        // Rewrite ONLY when targeting our bait file (paranoia: don't interfere
        // with other tools claude might try).
        let decision;
        if (body?.tool_name === 'Read' && body?.tool_input?.file_path === REQ_PATH) {
            decision = {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    permissionDecisionReason: 'auto-allowed by test',
                    updatedInput: {
                        file_path: REAL_PATH,
                    },
                },
            };
            console.error(`[mock-server]   → redirecting Read to ${REAL_PATH}`);
        } else {
            // Allow other tool calls untouched
            decision = {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    permissionDecisionReason: 'no-op',
                },
            };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision));
        return;
    }
    // Other hooks → 204
    res.writeHead(204).end();
});

async function startServer() {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            resolve(server.address().port);
        });
        server.on('error', reject);
    });
}

function writeSettings(port) {
    const cmd = (event) => `node "${FORWARDER}" ${port} ${event}`;
    const settings = {
        hooks: {
            PreToolUse: [
                {
                    matcher: '*',
                    hooks: [{ type: 'command', command: cmd('pre-tool-use'), timeout: 60_000 }],
                },
            ],
        },
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function runClaude() {
    return new Promise((resolve) => {
        const prompt = `Read the file at ${REQ_PATH} using the Read tool and output its first line.`;
        const args = [
            '--print',
            '--permission-mode',
            'bypassPermissions',
            '--settings',
            SETTINGS_PATH,
            '--allowedTools',
            'Read',
        ];
        const child = spawn('claude', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' },
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
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

(async () => {
    let exitCode = 1;
    try {
        const port = await startServer();
        writeSettings(port);
        const result = await runClaude();

        console.error('\n========== MODIFY VERIFICATION ==========');
        console.error(`Sentinel:        ${SENTINEL}`);
        console.error(`Requested path:  ${REQ_PATH}  (intentionally missing)`);
        console.error(`Real path:       ${REAL_PATH}`);
        console.error(`Hook calls:      ${calls.preToolUse.length}`);
        console.error(`Claude exit:     ${result.code}`);
        console.error('-----------------------------------------');

        const sentinelHit = result.stdout.includes(SENTINEL);
        const claudeSawMissing = /does not exist|not found|不存在|ENOENT/i.test(result.stdout);
        const readWasIntercepted = calls.preToolUse.some(
            (c) => c?.tool_name === 'Read' && c?.tool_input?.file_path === REQ_PATH,
        );

        if (sentinelHit && readWasIntercepted) {
            console.error('PASS: modifiedToolInput rewrote file_path; Claude received sentinel from REAL_PATH.');
            exitCode = 0;
        } else if (readWasIntercepted && claudeSawMissing) {
            console.error('FAIL: modifiedToolInput was IGNORED — claude tried original (missing) path.');
            exitCode = 2;
        } else if (readWasIntercepted) {
            console.error('PARTIAL: hook fired but sentinel not in output. Possibly truncated.');
            exitCode = 3;
        } else {
            console.error('FAIL: hook did not receive the expected Read call.');
            exitCode = 4;
        }
        console.error('=========================================\n');
    } catch (err) {
        console.error('[verify-modify] error:', err);
    } finally {
        server.close();
        try {
            fs.rmSync(HAPPY_TMP, { recursive: true, force: true });
        } catch {}
        process.exit(exitCode);
    }
})();
