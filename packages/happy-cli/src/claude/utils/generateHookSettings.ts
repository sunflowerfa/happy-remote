/**
 * Generate temporary settings file with Claude hooks for session tracking & permission interception
 *
 * Creates a settings.json file that configures Claude's hook system to:
 *   1. SessionStart      → notify happy-cli when session starts/forks/compacts
 *   2. PreToolUse        → intercept tool calls for remote permission approval (PTY mode)
 *   3. PostToolUse       → mirror tool results (PTY mode, optional)
 *   4. UserPromptSubmit  → mirror/capture user prompts (PTY mode)
 *   5. Stop              → mark assistant turn finished (PTY mode)
 *   6. Notification      → forward Claude's idle/notification events to mobile
 *
 * Only SessionStart is required in SDK mode (default for backwards compatibility).
 * Full hook set is generated for PTY mode where hooks replace SDK callbacks.
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

export type HookProfile = 'session-only' | 'full';

interface HookEntry {
    type: 'command';
    command: string;
    timeout?: number;
}

interface HookMatcher {
    matcher: string;
    hooks: HookEntry[];
}

interface ClaudeHookSettings {
    hooks: {
        SessionStart?: HookMatcher[];
        PreToolUse?: HookMatcher[];
        PostToolUse?: HookMatcher[];
        UserPromptSubmit?: HookMatcher[];
        Stop?: HookMatcher[];
        Notification?: HookMatcher[];
    };
}

function buildForwarderCommand(scriptName: string, port: number, eventName: string): string {
    const forwarderScript = resolve(projectPath(), 'scripts', scriptName);
    return `node "${forwarderScript}" ${port} ${eventName}`;
}

/**
 * Generate a temporary settings file with hook configuration
 *
 * @param port - The port where Happy hook server is listening
 * @param profile - Which hook profile to generate (default 'session-only' for SDK mode)
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, profile: HookProfile = 'session-only'): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Legacy session forwarder (one-way: stdin → POST → exit)
    const sessionForwarder = buildForwarderCommand('session_hook_forwarder.cjs', port, 'session-start');
    // Bidirectional forwarder (stdin → POST → stdout response, blocks Claude until reply)
    const eventForwarder = (eventName: string, timeoutMs?: number): HookEntry => ({
        type: 'command',
        command: buildForwarderCommand('hook_forwarder.cjs', port, eventName),
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });

    if (profile === 'session-only') {
        const settings: ClaudeHookSettings = {
            hooks: {
                SessionStart: [
                    { matcher: '*', hooks: [{ type: 'command', command: sessionForwarder }] },
                ],
            },
        };
        writeFileSync(filepath, JSON.stringify(settings, null, 2));
        logger.debug(`[generateHookSettings] Created session-only hook settings: ${filepath}`);
        return filepath;
    }

    // Full hook profile for PTY mode — every event routed back to happy-cli HTTP server.
    // PreToolUse gets a generous 600s timeout (Claude default) so mobile approval has time.
    const settings: ClaudeHookSettings = {
        hooks: {
            SessionStart: [
                { matcher: '*', hooks: [{ type: 'command', command: sessionForwarder }] },
            ],
            PreToolUse: [
                { matcher: '*', hooks: [eventForwarder('pre-tool-use', 600_000)] },
            ],
            PostToolUse: [
                { matcher: '*', hooks: [eventForwarder('post-tool-use', 30_000)] },
            ],
            UserPromptSubmit: [
                { matcher: '*', hooks: [eventForwarder('user-prompt-submit', 30_000)] },
            ],
            Stop: [
                { matcher: '*', hooks: [eventForwarder('stop', 30_000)] },
            ],
            Notification: [
                { matcher: '*', hooks: [eventForwarder('notification', 30_000)] },
            ],
        },
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created full hook settings: ${filepath}`);
    return filepath;
}

/**
 * Clean up the temporary hook settings file
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}
