#!/usr/bin/env node
/**
 * Bidirectional Hook Forwarder
 *
 * Generic forwarder for Claude Code hooks that need to receive a response
 * (unlike the SessionStart hook which is fire-and-forget).
 *
 * Lifecycle:
 *   1. Claude runs this script with stdin = JSON hook payload
 *   2. We POST the payload to http://127.0.0.1:<port>/hook/<event-name>
 *   3. happy-cli's hook server replies with a JSON decision body
 *   4. We write that body verbatim to our stdout
 *   5. Claude reads our stdout and acts on the decision
 *
 * Exit code semantics (per Claude Code hook spec):
 *   - 0  → success, stdout JSON consumed
 *   - 2  → blocking error (stderr fed back to Claude as error message)
 *   - !0 → non-blocking error, stdout ignored
 *
 * Usage:  node hook_forwarder.cjs <port> <event-name>
 * Example: hook_forwarder.cjs 52290 pre-tool-use
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
const eventName = (process.argv[3] || '').trim();

if (!port || isNaN(port) || !eventName) {
    // Without proper args, exit non-blocking so Claude continues normally.
    process.exit(0);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('error', () => {
    // stdin closed early — let Claude continue.
    process.exit(0);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);

    const req = http.request(
        {
            host: '127.0.0.1',
            port: port,
            method: 'POST',
            path: '/hook/' + eventName,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': body.length,
            },
            // PreToolUse may legitimately wait 10+ minutes for mobile approval.
            // We rely on Claude's own per-hook timeout (set in settings.json)
            // rather than enforce one here.
            timeout: 0,
        },
        (res) => {
            const respChunks = [];
            res.on('data', (c) => respChunks.push(c));
            res.on('end', () => {
                const respBody = Buffer.concat(respChunks).toString('utf-8');
                const statusCode = res.statusCode || 200;

                if (statusCode === 200 && respBody.length > 0) {
                    // Forward JSON decision body to Claude verbatim.
                    process.stdout.write(respBody, () => {
                        process.exit(0);
                    });
                } else if (statusCode === 204 || respBody.length === 0) {
                    // No-op decision — exit clean, let Claude continue.
                    process.exit(0);
                } else if (statusCode === 409) {
                    // Server explicitly asked to block. Body is the user-visible
                    // reason that Claude will surface as an error.
                    if (respBody) {
                        process.stderr.write(respBody);
                    }
                    process.exit(2);
                } else {
                    // Unexpected status — non-blocking error, let Claude continue.
                    process.exit(0);
                }
            });
        },
    );

    req.on('error', () => {
        // happy-cli unreachable — degrade gracefully, do not block Claude.
        process.exit(0);
    });

    req.end(body);
});

process.stdin.resume();
