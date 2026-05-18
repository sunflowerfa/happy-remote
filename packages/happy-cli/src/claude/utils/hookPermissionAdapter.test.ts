/**
 * Unit tests for hookPermissionAdapter — verifies that PermissionResult
 * shapes (the existing SDK contract) map correctly onto HookDecision
 * shapes that Claude Code's PreToolUse hook understands.
 *
 * We don't test the live PermissionHandler here (that's covered by SDK-
 * path integration tests); we inject a fake handler that returns the
 * exact PermissionResult shape we want to map, and assert the resulting
 * HookDecision body matches what the PreToolUse hook spec accepts.
 */

import { describe, it, expect } from 'vitest';
import { createPreToolUseDecider } from './hookPermissionAdapter';
import type { PermissionResult } from '../sdk/types';
import type { EnhancedMode } from '../loop';
import type { PermissionHandler } from './permissionHandler';

function fakeHandler(returns: PermissionResult): PermissionHandler {
    // We don't need any of the real instance — only `handleToolCall` is invoked.
    return {
        handleToolCall: async () => returns,
    } as unknown as PermissionHandler;
}

const baseMode: EnhancedMode = {
    permissionMode: 'default',
    model: undefined,
    fallbackModel: undefined,
    customSystemPrompt: undefined,
    appendSystemPrompt: undefined,
    allowedTools: undefined,
    disallowedTools: undefined,
    effort: undefined,
};

describe('hookPermissionAdapter', () => {
    it('maps allow + unchanged input → JSON allow (no updatedInput)', async () => {
        const decider = createPreToolUseDecider({
            permissionHandler: fakeHandler({
                behavior: 'allow',
                updatedInput: { file_path: '/etc/hostname' },
            }),
            getCurrentMode: () => baseMode,
        });
        const decision = await decider({
            tool_name: 'Read',
            tool_input: { file_path: '/etc/hostname' },
            tool_use_id: 'toolu_test_1',
        });
        expect(decision.type).toBe('json');
        if (decision.type !== 'json') throw new Error('unreachable');
        const body = decision.body as {
            hookSpecificOutput: {
                hookEventName: string;
                permissionDecision: string;
                updatedInput?: unknown;
                permissionDecisionReason?: string;
            };
        };
        expect(body.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
        // input unchanged → no updatedInput in output (avoids "last hook wins" races)
        expect(body.hookSpecificOutput.updatedInput).toBeUndefined();
    });

    it('maps allow + changed input → JSON allow WITH updatedInput', async () => {
        const decider = createPreToolUseDecider({
            permissionHandler: fakeHandler({
                behavior: 'allow',
                updatedInput: { file_path: '/etc/redirected' },
            }),
            getCurrentMode: () => baseMode,
        });
        const decision = await decider({
            tool_name: 'Read',
            tool_input: { file_path: '/etc/hostname' },
            tool_use_id: 'toolu_test_2',
        });
        if (decision.type !== 'json') throw new Error('expected json');
        const body = decision.body as {
            hookSpecificOutput: { updatedInput?: { file_path: string } };
        };
        expect(body.hookSpecificOutput.updatedInput).toEqual({ file_path: '/etc/redirected' });
    });

    it('maps deny → JSON deny with permissionDecisionReason from message', async () => {
        const decider = createPreToolUseDecider({
            permissionHandler: fakeHandler({
                behavior: 'deny',
                message: 'user rejected via mobile',
            }),
            getCurrentMode: () => baseMode,
        });
        const decision = await decider({
            tool_name: 'Bash',
            tool_input: { command: 'rm -rf /' },
            tool_use_id: 'toolu_test_3',
        });
        if (decision.type !== 'json') throw new Error('expected json');
        const body = decision.body as {
            hookSpecificOutput: {
                permissionDecision: string;
                permissionDecisionReason: string;
            };
        };
        expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(body.hookSpecificOutput.permissionDecisionReason).toContain('user rejected');
    });

    it('returns continue (204) when payload has no tool_name', async () => {
        const decider = createPreToolUseDecider({
            permissionHandler: fakeHandler({
                behavior: 'allow',
                updatedInput: {},
            }),
            getCurrentMode: () => baseMode,
        });
        const decision = await decider({});
        expect(decision.type).toBe('continue');
    });

    it('handles missing tool_use_id by synthesising a stable id', async () => {
        const decider = createPreToolUseDecider({
            permissionHandler: fakeHandler({
                behavior: 'allow',
                updatedInput: { file_path: '/etc/x' },
            }),
            getCurrentMode: () => baseMode,
        });
        // No tool_use_id provided — adapter should still produce a JSON decision,
        // not throw.
        const decision = await decider({
            tool_name: 'Read',
            tool_input: { file_path: '/etc/x' },
        });
        expect(decision.type).toBe('json');
    });

    it('on handler exception, denies the tool with a generic reason (fail-closed)', async () => {
        const throwingHandler = {
            handleToolCall: async () => {
                throw new Error('boom');
            },
        } as unknown as PermissionHandler;
        const decider = createPreToolUseDecider({
            permissionHandler: throwingHandler,
            getCurrentMode: () => baseMode,
        });
        const decision = await decider({
            tool_name: 'Read',
            tool_input: { file_path: '/etc/x' },
            tool_use_id: 'toolu_err',
        });
        if (decision.type !== 'json') throw new Error('expected json');
        const body = decision.body as {
            hookSpecificOutput: { permissionDecision: string };
        };
        expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    });
});
