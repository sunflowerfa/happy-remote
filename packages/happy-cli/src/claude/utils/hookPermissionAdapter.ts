/**
 * Hook → Permission decision adapter
 *
 * Bridges Claude Code's PreToolUse hook (HTTP) and the existing
 * PermissionHandler that was originally written for the Agent SDK's
 * `canCallTool` callback.
 *
 * Why this exists
 * ---------------
 * In PTY mode we no longer have a `canCallTool` callback (that's an Agent
 * SDK-only mechanism that counts against the new programmatic-usage credit
 * pool). Instead we configure Claude to invoke a PreToolUse hook on every
 * tool call; the hook forwards the payload to happy-cli's HTTP server, we
 * decide here, and the response body is forwarded back to Claude.
 *
 * The decision logic itself (allowed tools, bash prefix matching, plan
 * mode, etc.) is identical to the SDK path — we delegate to the same
 * PermissionHandler instance the codebase already uses. The only thing
 * that changes is the entry/exit shape.
 *
 * Wire shapes
 * -----------
 * Input  (from hook_forwarder.cjs):
 *   {
 *     session_id: "...",
 *     tool_name: "Bash",
 *     tool_input: { command: "ls" },
 *     tool_use_id: "toolu_...",     // present since claude-code >= 2.0.x
 *     ...
 *   }
 *
 * Output (returned as HookDecision):
 *   - { type: 'continue' }                                  → 204, default behavior
 *   - { type: 'json', body: { hookSpecificOutput: {...} } } → 200, deny/allow/updatedInput
 *
 * Note: we deliberately avoid HTTP 409 (blocking error) because Claude
 * surfaces those as RUNTIME errors to the model, which is not what we
 * want for clean "tool was denied" UX — `permissionDecision: 'deny'`
 * + `permissionDecisionReason` is the canonical denial path.
 */

import { logger } from '@/ui/logger';
import { PermissionHandler } from './permissionHandler';
import type { HookDecision, ToolHookData } from './startHookServer';
import type { PermissionResult } from '../sdk/types';
import type { EnhancedMode } from '../loop';

/**
 * Stable synthetic toolUseID generator for hook calls that arrive without a
 * `tool_use_id` (older claude-code builds). Falls back to a per-request
 * pseudo-id derived from tool_name + JSON(tool_input). This is only used as
 * a key for the in-flight pending-request map; never persisted.
 */
let syntheticCounter = 0;
function synthesizeToolUseId(data: ToolHookData): string {
    if (typeof data.tool_use_id === 'string' && data.tool_use_id.length > 0) {
        return data.tool_use_id;
    }
    syntheticCounter += 1;
    const fingerprint = `${data.tool_name ?? 'unknown'}:${JSON.stringify(data.tool_input ?? {})}`;
    return `synthetic-${syntheticCounter}-${Buffer.from(fingerprint).toString('base64').slice(0, 12)}`;
}

/**
 * Convert a PermissionResult (from PermissionHandler) into a hook decision
 * Claude will understand.
 */
function permissionResultToHookDecision(
    result: PermissionResult,
    toolName: string,
    originalInput: Record<string, unknown> | undefined,
): HookDecision {
    if (result.behavior === 'allow') {
        const updatedInput = result.updatedInput ?? originalInput ?? {};
        // Only attach updatedInput when it actually differs — avoids spurious
        // "the last hook wins" races when no rewrite was intended.
        const inputChanged =
            updatedInput !== originalInput &&
            JSON.stringify(updatedInput) !== JSON.stringify(originalInput ?? {});

        const hookSpecificOutput: Record<string, unknown> = {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: `Approved by happy-cli (tool: ${toolName})`,
        };
        if (inputChanged) {
            hookSpecificOutput.updatedInput = updatedInput;
        }
        return { type: 'json', body: { hookSpecificOutput } };
    }

    // behavior === 'deny'
    const reason =
        ('message' in result && typeof result.message === 'string' && result.message) ||
        `Denied by happy-cli (tool: ${toolName})`;
    return {
        type: 'json',
        body: {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: reason,
            },
        },
    };
}

export interface HookPermissionAdapterOptions {
    permissionHandler: PermissionHandler;
    /** Returns the current EnhancedMode (model + permission mode + system prompt + ...) */
    getCurrentMode: () => EnhancedMode;
    /**
     * Optional global abort signal. When the active "turn" is aborted, any in-flight
     * permission requests are cancelled with the signal so we don't leak pending
     * approvals across sessions.
     */
    getAbortSignal?: () => AbortSignal | undefined;
}

/**
 * Build the onPreToolUse callback used by startHookServer's options.
 *
 * The returned function is async and may block for up to the hook timeout
 * (default 600s) while waiting for the mobile app to respond.
 */
export function createPreToolUseDecider(
    opts: HookPermissionAdapterOptions,
): (data: ToolHookData) => Promise<HookDecision> {
    return async (data: ToolHookData): Promise<HookDecision> => {
        const toolName = data.tool_name;
        if (!toolName) {
            logger.debug('[hookAdapter] PreToolUse without tool_name — allowing');
            return { type: 'continue' };
        }
        const toolInput = data.tool_input ?? {};
        const toolUseID = synthesizeToolUseId(data);
        const mode = opts.getCurrentMode();
        const ambientSignal = opts.getAbortSignal?.();

        // The PermissionHandler.handleToolCall expects an AbortController-style
        // signal so it can clean up if the request is aborted. We give it the
        // ambient one when available, otherwise a never-fired signal.
        const signal = ambientSignal ?? new AbortController().signal;

        try {
            logger.debug(
                `[hookAdapter] PreToolUse tool=${toolName} toolUseID=${toolUseID} mode=${mode.permissionMode}`,
            );
            const result: PermissionResult = await opts.permissionHandler.handleToolCall(
                toolName,
                toolInput,
                mode,
                { signal, toolUseID },
            );
            const decision = permissionResultToHookDecision(
                result,
                toolName,
                toolInput as Record<string, unknown>,
            );
            logger.debug(
                `[hookAdapter] PreToolUse decision toolUseID=${toolUseID} behavior=${result.behavior}`,
            );
            return decision;
        } catch (err) {
            logger.debug(`[hookAdapter] PreToolUse handler threw — denying tool. err=${String(err)}`);
            return {
                type: 'json',
                body: {
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'happy-cli aborted or encountered an internal error',
                    },
                },
            };
        }
    };
}
