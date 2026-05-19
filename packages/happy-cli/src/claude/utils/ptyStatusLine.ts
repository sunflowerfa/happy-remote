/**
 * Parser for Claude Code's PTY status line.
 *
 * Claude renders a single-line footer like
 *   `Working… (10m 12s · ↓ 8.3k tokens · almost done thinking with max effort)`
 * while a turn is in flight. The numbers live only in the TUI byte stream
 * (jsonl writes are turn-final), so happy-cli's PTY driver scrapes the
 * line out of a sliding ANSI-stripped buffer and forwards it as an
 * ephemeral socket event for the mobile app.
 *
 * This module owns the regex and the stable-hash diff. It accepts an
 * already ANSI-stripped string (the same `clean` value claudeRemotePty
 * uses for trust/ready/thinking detection) and returns the most recent
 * status snippet, or null when nothing matches.
 */

export interface PtyStatusLine {
    /** Milliseconds since the current turn started. */
    elapsedMs: number;
    /** Running token counter (already expanded from `8.3k` → 8300). */
    tokens: number;
    /** Claude effort label (e.g. "max", "high"); absent when not shown. */
    effort?: string;
    /** Short task description Claude prints just above the numeric line. */
    title?: string;
}

/**
 * Match the *innermost* parenthesised status segment that contains
 * "Xs · ↑/↓ N tokens". Claude separates fields with middle-dot `·`
 * but we accept `•` and `⋅` too for older builds / theme variants.
 *
 * We do NOT anchor on "Working" — that prefix is localised and gets
 * rotated through other gerunds ("Crafting", "Engineering", …). The
 * unique fingerprint is `<digits>s · <arrow> <digits>[k] tokens`.
 */
const STATUS_LINE_REGEX = /\(([^()]*?(?:(\d+)m\s*)?(\d+)s\s*[·•⋅]\s*[↑↓⇡⇣]\s*([\d.]+)\s*([kKmM]?)\s*tokens([^()]*))\)/g;

/**
 * Match a likely "task title" — the short line Claude prints above the
 * numeric footer (e.g. "Rewriting entrance animation CSS…"). It's not
 * always present, the gerund vocabulary is loose, and Chinese/Japanese
 * variants exist too. We look for a short trailing-ellipsis sentence
 * that appears just before the next status-line match.
 */
const TITLE_NEAR_STATUS_REGEX = /([^\n\r·•⋅()]{2,80}?)[…\.]{1,3}\s*$/;

/**
 * Extract the most recent status line from an ANSI-stripped PTY buffer.
 *
 * Returns null if no candidate is present (Claude isn't thinking, or
 * the footer format changed in a future release — in which case we
 * silently fall back to the existing thinking-boolean signal).
 */
export function extractPtyStatusLine(cleanBuffer: string): PtyStatusLine | null {
    if (!cleanBuffer) return null;

    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    STATUS_LINE_REGEX.lastIndex = 0;
    while ((m = STATUS_LINE_REGEX.exec(cleanBuffer)) !== null) {
        lastMatch = m;
    }
    if (!lastMatch) return null;

    const [fullParen, inner, minStr, secStr, numStr, suffix, tail] = lastMatch;
    void fullParen;
    void inner;

    const minutes = minStr ? parseInt(minStr, 10) : 0;
    const seconds = parseInt(secStr, 10);
    if (Number.isNaN(seconds)) return null;
    const elapsedMs = (minutes * 60 + seconds) * 1000;

    const baseTokens = parseFloat(numStr);
    if (!Number.isFinite(baseTokens)) return null;
    const tokens = expandTokenCount(baseTokens, suffix);

    const effortMatch = tail.match(/with\s+([\w-]+)\s+effort/i);
    const effort = effortMatch ? effortMatch[1].toLowerCase() : undefined;

    const matchStart = lastMatch.index;
    const title = extractTitleNearStatus(cleanBuffer, matchStart);

    const result: PtyStatusLine = { elapsedMs, tokens };
    if (effort) result.effort = effort;
    if (title) result.title = title;
    return result;
}

function expandTokenCount(value: number, suffix: string): number {
    const factor = suffix === 'k' || suffix === 'K' ? 1_000
        : suffix === 'm' || suffix === 'M' ? 1_000_000
        : 1;
    return Math.round(value * factor);
}

function extractTitleNearStatus(buffer: string, statusStart: number): string | undefined {
    // Look at the ~200 chars immediately preceding the status line. The
    // title (when present) is the last non-empty line that ends with an
    // ellipsis. Strip leading bullet/marker characters Claude uses to
    // decorate the active task ("• ", "› ", "* ").
    const windowStart = Math.max(0, statusStart - 200);
    const window = buffer.slice(windowStart, statusStart);
    const lines = window.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].replace(/^[•›*>\-\s]+/, '').trim();
        if (!line) continue;
        const titled = line.match(TITLE_NEAR_STATUS_REGEX);
        if (titled) {
            const candidate = titled[1].trim();
            if (candidate.length >= 2 && candidate.length <= 80) {
                return candidate;
            }
        }
    }
    return undefined;
}

/**
 * Stable fingerprint of a status line — used to skip redundant emits
 * when Claude redraws the same numbers between PTY chunks.
 */
export function ptyStatusLineHash(s: PtyStatusLine): string {
    return `${s.elapsedMs}|${s.tokens}|${s.effort ?? ''}|${s.title ?? ''}`;
}
