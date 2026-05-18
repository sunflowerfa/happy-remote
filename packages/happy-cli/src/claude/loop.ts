import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher, LauncherResult } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { claudeRemotePtyLauncher } from "./claudeRemotePtyLauncher"
import { ApiClient } from "@/lib"
import type { JsRuntime } from "./runClaude"
import type { SandboxConfig } from "@/persistence"
import type { HookServer } from "./utils/startHookServer"

// Re-export permission mode type from api/types
// Single unified type with 7 modes - Codex modes mapped at SDK boundary
export type { PermissionMode } from "@/api/types"
import type { PermissionMode } from "@/api/types"

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'max';

/**
 * Which implementation drives the remote mode. Defaults to 'pty':
 *   - 'pty': spawn interactive `claude` under node-pty. Bills against the
 *           user's regular interactive subscription pool. Requires the
 *           PreToolUse hook for tool permission decisions. Default.
 *   - 'sdk': use @anthropic-ai/claude-agent-sdk's query(). Bills against
 *           the new Agent-SDK programmatic-usage credit pool (going live
 *           2026-06-15). Kept available as an escape hatch for users
 *           with API credits / Max plans where the SDK pool is large.
 */
export type RemoteImpl = 'pty' | 'sdk';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    /** Effort level passed through to the Claude Agent SDK as the `effort` option. */
    effort?: ClaudeEffort;
}

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    onModeChange: (mode: 'local' | 'remote') => void
    mcpServers: Record<string, any>
    session: ApiSessionClient
    api: ApiClient,
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    allowedTools?: string[]
    sandboxConfig?: SandboxConfig
    onSessionReady?: (session: Session) => void
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    /**
     * Which remote-mode driver to use. PTY is default and avoids the
     * Agent-SDK programmatic-usage credit pool. Only required when remoteImpl
     * is 'pty', but harmless when omitted in SDK mode.
     */
    remoteImpl?: RemoteImpl
    /**
     * Hook server reference. PTY mode injects its PreToolUse decider into
     * this server via setHandlers; SDK mode ignores it.
     */
    hookServer: HookServer
}

export async function loop(opts: LoopOptions): Promise<number> {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        sandboxConfig: opts.sandboxConfig,
        onModeChange: opts.onModeChange,
        hookSettingsPath: opts.hookSettingsPath,
        jsRuntime: opts.jsRuntime
    });

    opts.onSessionReady?.(session)

    const remoteImpl: RemoteImpl = opts.remoteImpl ?? 'pty';
    logger.debug(`[loop] remote driver: ${remoteImpl}`);

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);

        switch (mode) {
            case 'local': {
                const result = await claudeLocalLauncher(session);
                switch (result.type ) {
                    case 'switch':
                        mode = 'remote';
                        opts.onModeChange?.(mode);
                        break;
                    case 'exit':
                        return result.code;
                    default:
                        const _: never = result satisfies never;
                }
                break;
            }

            case 'remote': {
                const reason = remoteImpl === 'pty'
                    ? await claudeRemotePtyLauncher({ session, hookServer: opts.hookServer })
                    : await claudeRemoteLauncher(session);
                switch (reason) {
                    case 'exit':
                        return 0;
                    case 'switch':
                        mode = 'local';
                        opts.onModeChange?.(mode);
                        break;
                    default:
                        const _: never = reason satisfies never;
                }
                break;
            }

            default: {
                const _: never = mode satisfies never;
            }
        }
    }
}
