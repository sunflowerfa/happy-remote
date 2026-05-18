/**
 * Dedicated HTTP server for receiving Claude session hooks
 *
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook,
 * AND — in PTY mode — receives every PreToolUse / PostToolUse / Stop /
 * UserPromptSubmit / Notification event so happy-cli can fully replace
 * what Agent SDK callbacks used to do.
 *
 * Separate from the MCP server to keep concerns isolated.
 *
 * ## Routes
 * - POST /hook/session-start       SessionStart   (one-way, sessionId notify)
 * - POST /hook/pre-tool-use        PreToolUse     (BIDIRECTIONAL — decides allow/deny/modify)
 * - POST /hook/post-tool-use       PostToolUse    (informational)
 * - POST /hook/user-prompt-submit  UserPromptSubmit (can rewrite/block user input)
 * - POST /hook/stop                Stop           (assistant turn finished)
 * - POST /hook/notification        Notification   (idle / waiting-for-input hints)
 *
 * Each route receives the raw JSON payload Claude wrote to the hook's stdin.
 * For BIDIRECTIONAL routes, the response body is forwarded verbatim back to
 * Claude as the hook's stdout — Claude then applies the decision.
 *
 * ## Response semantics (matches Claude Code's hook decision schema)
 *   200 + JSON  → forward to Claude as-is (e.g. `{"hookSpecificOutput": {...}}`)
 *   204         → no-op, Claude continues with default behavior
 *   409 + text  → blocking error, body becomes user-visible reason
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { logger } from '@/ui/logger';

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    [key: string]: unknown;
}

/**
 * Data received from PreToolUse / PostToolUse hooks
 */
export interface ToolHookData {
    session_id?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    tool_use_id?: string;
    hook_event_name?: string;
    transcript_path?: string;
    cwd?: string;
    [key: string]: unknown;
}

/**
 * Data received from UserPromptSubmit hook
 */
export interface UserPromptHookData {
    session_id?: string;
    prompt?: string;
    hook_event_name?: string;
    transcript_path?: string;
    cwd?: string;
    [key: string]: unknown;
}

/**
 * Data received from Stop / Notification hooks
 */
export interface GenericHookData {
    session_id?: string;
    hook_event_name?: string;
    transcript_path?: string;
    cwd?: string;
    message?: string;
    [key: string]: unknown;
}

/**
 * Hook decision returned to Claude. Either a structured JSON body that
 * Claude interprets (forwarded as stdout), or a blocking-error payload
 * (HTTP 409 + reason text).
 */
export type HookDecision =
    | { type: 'continue' } // 204 — no-op
    | { type: 'json'; body: unknown } // 200 + JSON
    | { type: 'block'; reason: string }; // 409 + plain text

export interface HookServerOptions {
    /** Called when SessionStart hook fires with a valid sessionId. */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;

    /**
     * Called for every PreToolUse hook. Must return a decision.
     * Default behavior when omitted: { type: 'continue' } (Claude proceeds).
     */
    onPreToolUse?: (data: ToolHookData) => Promise<HookDecision>;

    /** Called for every PostToolUse hook (informational, decision is ignored). */
    onPostToolUse?: (data: ToolHookData) => Promise<HookDecision>;

    /** Called for every UserPromptSubmit hook. Can rewrite/block user prompt. */
    onUserPromptSubmit?: (data: UserPromptHookData) => Promise<HookDecision>;

    /** Called for every Stop hook — Claude finished its assistant turn. */
    onStop?: (data: GenericHookData) => Promise<HookDecision>;

    /** Called for every Notification hook — Claude is idle / waiting for input. */
    onNotification?: (data: GenericHookData) => Promise<HookDecision>;
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Stop the server */
    stop: () => void;
    /** Replace the active handler set (used when switching local↔remote modes) */
    setHandlers: (next: Partial<HookServerOptions>) => void;
}

const ROUTE_TIMEOUT_MS: Record<string, number> = {
    '/hook/session-start': 5_000,
    '/hook/pre-tool-use': 605_000, // 600s for hook + 5s slack
    '/hook/post-tool-use': 35_000,
    '/hook/user-prompt-submit': 35_000,
    '/hook/stop': 35_000,
    '/hook/notification': 35_000,
};

/**
 * Start a dedicated HTTP server for receiving Claude hooks
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    // Mutable handler ref so caller can swap callbacks per-mode without restarting.
    let handlers: HookServerOptions = { ...options };

    async function readBody(req: IncomingMessage, timeoutMs: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            const timer = setTimeout(() => {
                reject(new Error('request body timeout'));
            }, timeoutMs);
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                clearTimeout(timer);
                resolve(Buffer.concat(chunks));
            });
            req.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    function safeParseJson<T>(buf: Buffer): T | null {
        try {
            return JSON.parse(buf.toString('utf-8')) as T;
        } catch {
            return null;
        }
    }

    function writeDecision(res: ServerResponse, decision: HookDecision): void {
        if (decision.type === 'continue') {
            res.writeHead(204).end();
            return;
        }
        if (decision.type === 'json') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision.body));
            return;
        }
        // block
        res.writeHead(409, { 'Content-Type': 'text/plain' }).end(decision.reason);
    }

    async function handleSessionStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const body = await readBody(req, ROUTE_TIMEOUT_MS['/hook/session-start']);
            const data = safeParseJson<SessionHookData>(body) ?? {};
            const sessionId = data.session_id || data.sessionId;
            if (sessionId) {
                logger.debug(`[hookServer] SessionStart sessionId=${sessionId}`);
                handlers.onSessionHook(sessionId, data);
            } else {
                logger.debug('[hookServer] SessionStart with no session_id');
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        } catch (err) {
            logger.debug('[hookServer] SessionStart error:', err);
            if (!res.headersSent) res.writeHead(500).end('error');
        }
    }

    async function handleBidirectional<T>(
        req: IncomingMessage,
        res: ServerResponse,
        routePath: string,
        callback: ((data: T) => Promise<HookDecision>) | undefined,
    ): Promise<void> {
        try {
            const body = await readBody(req, ROUTE_TIMEOUT_MS[routePath] ?? 30_000);
            const data = safeParseJson<T>(body);
            if (!data || !callback) {
                writeDecision(res, { type: 'continue' });
                return;
            }
            const decision = await callback(data);
            writeDecision(res, decision);
        } catch (err) {
            logger.debug(`[hookServer] ${routePath} error:`, err);
            if (!res.headersSent) {
                // On callback failure, do NOT block — let Claude continue.
                writeDecision(res, { type: 'continue' });
            }
        }
    }

    return new Promise((resolve, reject) => {
        const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.method !== 'POST') {
                res.writeHead(404).end('not found');
                return;
            }
            switch (req.url) {
                case '/hook/session-start':
                    handleSessionStart(req, res);
                    return;
                case '/hook/pre-tool-use':
                    handleBidirectional<ToolHookData>(req, res, req.url, handlers.onPreToolUse);
                    return;
                case '/hook/post-tool-use':
                    handleBidirectional<ToolHookData>(req, res, req.url, handlers.onPostToolUse);
                    return;
                case '/hook/user-prompt-submit':
                    handleBidirectional<UserPromptHookData>(req, res, req.url, handlers.onUserPromptSubmit);
                    return;
                case '/hook/stop':
                    handleBidirectional<GenericHookData>(req, res, req.url, handlers.onStop);
                    return;
                case '/hook/notification':
                    handleBidirectional<GenericHookData>(req, res, req.url, handlers.onNotification);
                    return;
                default:
                    res.writeHead(404).end('not found');
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }
            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);
            resolve({
                port,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                },
                setHandlers: (next) => {
                    handlers = { ...handlers, ...next };
                    logger.debug(`[hookServer] Handlers updated (keys: ${Object.keys(next).join(',')})`);
                },
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error:', err);
            reject(err);
        });
    });
}
