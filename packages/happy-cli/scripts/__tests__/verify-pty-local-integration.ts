/**
 * Local integration of happy-cli's real PTY-mode modules
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ This test wires together the EXACT happy-cli modules    │
 *   │ that runClaude.ts uses in production, minus the         │
 *   │ Session/ApiClient/WebSocket layer (which talks to       │
 *   │ happy-server). It proves that:                          │
 *   │                                                          │
 *   │  • startHookServer (real impl)                           │
 *   │  • generateHookSettingsFile(port, 'full') (real impl)    │
 *   │  • startClaudeRemotePty (real impl)                      │
 *   │  • createPreToolUseDecider (real impl)                   │
 *   │  • resolveClaudeBinary (real impl)                       │
 *   │                                                          │
 *   │ all hook up correctly and intercept a real tool call,    │
 *   │ even though we mock out PermissionHandler + Session.     │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Run with: pnpm exec tsx scripts/__tests__/verify-pty-local-integration.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHookServer } from '../../src/claude/utils/startHookServer';
import {
    generateHookSettingsFile,
    cleanupHookSettingsFile,
} from '../../src/claude/utils/generateHookSettings';
import { startClaudeRemotePty } from '../../src/claude/claudeRemotePty';
import { createPreToolUseDecider } from '../../src/claude/utils/hookPermissionAdapter';
import { resolveClaudeBinary } from '../../src/claude/utils/resolveClaudeBinary';
import type { PermissionHandler } from '../../src/claude/utils/permissionHandler';
import type { EnhancedMode } from '../../src/claude/loop';
import type { PermissionResult } from '../../src/claude/sdk/types';

const RUN_DIR = mkdtempSync(join(tmpdir(), 'happy-pty-local-'));

const events = {
    sessionStart: 0,
    preToolUseDeciderInvoked: 0,
    stopHookFired: 0,
    userPromptSubmit: 0,
    permissionHandlerCalls: [] as Array<{ toolName: string; input: unknown }>,
};

async function main() {
    console.error('[local] run dir:', RUN_DIR);

    // Step 1: resolve claude binary (real impl)
    const claudeBin = await resolveClaudeBinary();
    if (!claudeBin) {
        console.error('FAIL: resolveClaudeBinary returned null');
        process.exit(2);
    }
    console.error('[local] claude bin:', claudeBin);

    // Step 2: start hook server (real impl)
    let sessionIdFromHook: string | null = null;
    const hookServer = await startHookServer({
        onSessionHook: (sid) => {
            sessionIdFromHook = sid;
            events.sessionStart++;
            console.error('[local] SessionStart sid=', sid);
        },
    });
    console.error('[local] hookServer port:', hookServer.port);

    // Step 3: generate hook settings (real impl, 'full' profile)
    const hookSettingsPath = generateHookSettingsFile(hookServer.port, 'full');
    console.error('[local] hookSettingsPath:', hookSettingsPath);

    // Step 4: wire PreToolUse decider into hookServer (real impl)
    //
    // Mock PermissionHandler — auto-allow every tool, but record the call so
    // we can prove it was routed through the adapter (not just the hook).
    const fakeHandler: PermissionHandler = {
        handleToolCall: async (
            toolName: string,
            input: unknown,
        ): Promise<PermissionResult> => {
            events.permissionHandlerCalls.push({ toolName, input });
            console.error(`[local] PermissionHandler invoked tool=${toolName}`);
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        },
    } as unknown as PermissionHandler;

    const baseMode: EnhancedMode = {
        permissionMode: 'bypassPermissions',
        model: undefined,
        fallbackModel: undefined,
        customSystemPrompt: undefined,
        appendSystemPrompt: undefined,
        allowedTools: undefined,
        disallowedTools: undefined,
        effort: undefined,
    };

    const preToolUseDecider = createPreToolUseDecider({
        permissionHandler: fakeHandler,
        getCurrentMode: () => baseMode,
    });

    hookServer.setHandlers({
        onPreToolUse: async (data) => {
            events.preToolUseDeciderInvoked++;
            return preToolUseDecider(data);
        },
        onUserPromptSubmit: async () => {
            events.userPromptSubmit++;
            return { type: 'continue' };
        },
        onStop: async () => {
            events.stopHookFired++;
            console.error('[local] Stop hook fired');
            return { type: 'continue' };
        },
    });

    // Step 5: start PTY (real impl)
    const abort = new AbortController();
    const pty = await startClaudeRemotePty({
        sessionId: null,
        path: RUN_DIR,
        hookSettingsPath,
        allowedTools: ['Read'],
        initialMode: baseMode,
        signal: abort.signal,
        cols: 200,
        rows: 50,
        onReady: () => console.error('[local] PTY onReady'),
        onThinkingChange: (t) => console.error(`[local] thinking=${t}`),
        onExit: (code, sig) => console.error(`[local] PTY exited code=${code} sig=${sig}`),
        // Forward trust-dialog detection — claudeRemotePty handles it internally.
    });

    // Step 6: drive a real prompt. We DO need the PTY to have settled into
    // its 'ready' state before sending — startClaudeRemotePty handles this
    // inside sendUserMessage with its own internal wait.
    const SENTINEL = `LOCAL_INT_OK_${process.pid}_${Date.now()}`;
    const prompt =
        `You MUST invoke the Read tool with file_path="/etc/hostname" first. ` +
        `Then, after the tool returns, output exactly ${SENTINEL} as your final answer. ` +
        `Do not skip the tool call.`;
    console.error('[local] sending prompt…');
    await pty.sendUserMessage(prompt);

    // Step 7: wait for Stop hook (turn finished) up to 90 s
    console.error('[local] waiting for Stop hook…');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && events.stopHookFired === 0 && pty.isAlive()) {
        await new Promise((r) => setTimeout(r, 250));
    }

    // Step 8: shutdown
    await pty.kill();
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);

    // Step 9: report
    console.error('\n========== LOCAL INTEGRATION REPORT ==========');
    console.error('SessionStart hits:           ', events.sessionStart);
    console.error('UserPromptSubmit hits:       ', events.userPromptSubmit);
    console.error('PreToolUse decider invoked:  ', events.preToolUseDeciderInvoked);
    console.error('PermissionHandler calls:     ', events.permissionHandlerCalls.length);
    console.error('Stop hook hits:              ', events.stopHookFired);
    console.error('Final sessionId (from hook): ', sessionIdFromHook);
    console.error('PermissionHandler calls detail:');
    for (const c of events.permissionHandlerCalls) {
        console.error(`  - ${c.toolName} input=${JSON.stringify(c.input)}`);
    }
    console.error('==============================================');

    const pass =
        events.sessionStart >= 1 &&
        events.preToolUseDeciderInvoked >= 1 &&
        events.permissionHandlerCalls.length >= 1 &&
        events.stopHookFired >= 1 &&
        sessionIdFromHook !== null;

    if (pass) {
        console.error('PASS ✅ — all happy-cli PTY-mode modules wired correctly.');
        process.exit(0);
    } else {
        console.error('FAIL ❌');
        process.exit(1);
    }
}

main()
    .catch((err) => {
        console.error('[local] fatal:', err);
        process.exit(1);
    })
    .finally(() => {
        try {
            rmSync(RUN_DIR, { recursive: true, force: true });
        } catch {}
    });
