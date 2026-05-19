import * as z from 'zod';

/**
 * SessionProgress — live state-line snapshot from a PTY-driven Claude session.
 *
 * Claude Code renders a status line like
 *   `Working… (10m 12s · ↓ 8.3k tokens · almost done thinking with max effort)`
 * at the bottom of its TUI. Those numbers exist only in the PTY byte stream;
 * the jsonl transcript doesn't carry them. happy-cli scrapes the line from
 * the PTY buffer and forwards this payload as an ephemeral socket event so
 * the mobile app can mirror the desktop view while a turn is in flight.
 *
 * Field semantics:
 *  - `elapsedMs`  — milliseconds since the current turn started thinking
 *                   (parsed from the `Xm Ys` token; if only seconds shown,
 *                   minutes is treated as 0).
 *  - `tokens`     — running counter from the `↓ N tokens` segment. Number
 *                   already expanded from `8.3k` to 8300.
 *  - `effort`     — optional Claude effort label (e.g. "max" / "high"); the
 *                   exact string Claude prints, kept verbatim.
 *  - `title`      — optional short description Claude prints just above the
 *                   numeric line (e.g. "Rewriting entrance animation CSS").
 *                   Best-effort; absent when scrape misses.
 */
export const SessionProgressSchema = z.object({
  sid: z.string(),
  time: z.number(),
  elapsedMs: z.number().int().min(0),
  tokens: z.number().int().min(0),
  effort: z.string().optional(),
  title: z.string().optional(),
});

export type SessionProgress = z.infer<typeof SessionProgressSchema>;
