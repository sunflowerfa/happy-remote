/**
 * Resolve the path to the user-installed `claude` binary.
 *
 * Delegates to the existing CJS helper `scripts/claude_version_utils.cjs`,
 * which already understands every installation method happy-cli supports
 * (npm global, Homebrew, native installer, PATH fallback). Falls back to
 * `which claude` if the helper can't be loaded.
 *
 * Used by claudeRemotePty.ts — node-pty's posix_spawnp needs an absolute
 * or PATH-resolvable executable.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';

let cachedPath: string | null | undefined;

export async function resolveClaudeBinary(): Promise<string | null> {
    if (cachedPath !== undefined) return cachedPath;

    // First try the canonical helper used everywhere else in the codebase.
    try {
        const utilsPath = resolve(projectPath(), 'scripts', 'claude_version_utils.cjs');
        if (existsSync(utilsPath)) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const utils = require(utilsPath) as {
                findGlobalClaudeCliPath?: () => { path?: string; source?: string } | null;
            };
            const result = utils.findGlobalClaudeCliPath?.();
            if (result?.path && existsSync(result.path)) {
                logger.debug(`[resolveClaudeBinary] via utils: ${result.path} (source=${result.source})`);
                cachedPath = result.path;
                return cachedPath;
            }
        }
    } catch (err) {
        logger.debug(`[resolveClaudeBinary] helper load failed: ${String(err)}`);
    }

    // Fallback: $(which claude). Works for native installer + Homebrew.
    try {
        const which = execSync('which claude', { encoding: 'utf-8' }).trim();
        if (which && existsSync(which)) {
            logger.debug(`[resolveClaudeBinary] via which: ${which}`);
            cachedPath = which;
            return cachedPath;
        }
    } catch {
        // ignore
    }

    cachedPath = null;
    return null;
}

/** Reset the resolver cache (used in tests). */
export function _resetClaudeBinaryResolverCache(): void {
    cachedPath = undefined;
}
