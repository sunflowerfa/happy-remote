import { describe, it, expect } from 'vitest';
import { extractPtyStatusLine, ptyStatusLineHash } from './ptyStatusLine';

describe('extractPtyStatusLine', () => {
    it('parses the canonical Claude footer with minutes, kilo tokens, effort', () => {
        const buf = 'Working (10m 12s · ↓ 8.3k tokens · almost done thinking with max effort)';
        const r = extractPtyStatusLine(buf);
        expect(r).not.toBeNull();
        expect(r!.elapsedMs).toBe((10 * 60 + 12) * 1000);
        expect(r!.tokens).toBe(8300);
        expect(r!.effort).toBe('max');
    });

    it('parses seconds-only with up-arrow and no effort suffix', () => {
        const buf = 'Crafting (45s · ↑ 1200 tokens · esc to interrupt)';
        const r = extractPtyStatusLine(buf);
        expect(r).not.toBeNull();
        expect(r!.elapsedMs).toBe(45_000);
        expect(r!.tokens).toBe(1200);
        expect(r!.effort).toBeUndefined();
    });

    it('handles the bullet-dot separator and high effort label', () => {
        const buf = 'Engineering (2m 5s • ↓ 12.7k tokens • with high effort)';
        const r = extractPtyStatusLine(buf);
        expect(r).not.toBeNull();
        expect(r!.elapsedMs).toBe(125_000);
        expect(r!.tokens).toBe(12_700);
        expect(r!.effort).toBe('high');
    });

    it('returns the latest match when buffer holds historical lines', () => {
        const buf = [
            'Working (1m 0s · ↓ 1.0k tokens · with low effort)',
            'Crafting (1m 30s · ↓ 2.5k tokens · with medium effort)',
            'Designing (2m 0s · ↓ 4.4k tokens · with max effort)',
        ].join('\n');
        const r = extractPtyStatusLine(buf);
        expect(r!.elapsedMs).toBe(120_000);
        expect(r!.tokens).toBe(4400);
        expect(r!.effort).toBe('max');
    });

    it('returns null when no matching parenthesised footer is present', () => {
        expect(extractPtyStatusLine('')).toBeNull();
        expect(extractPtyStatusLine('? for shortcuts')).toBeNull();
        expect(extractPtyStatusLine('Yes, I trust this folder')).toBeNull();
    });

    it('survives garbage tail without matching tokens', () => {
        const buf = '(1m 0s · some other content without tokens word)';
        expect(extractPtyStatusLine(buf)).toBeNull();
    });

    it('captures a title line ending with ellipsis just above the footer', () => {
        const buf = [
            '  Rewriting entrance animation CSS…',
            'Working (10m 12s · ↓ 8.3k tokens · with max effort)',
        ].join('\n');
        const r = extractPtyStatusLine(buf);
        expect(r!.title).toBe('Rewriting entrance animation CSS');
    });

    it('strips bullet decoration from the title', () => {
        const buf = [
            '› Refactoring auth middleware…',
            'Engineering (3m 4s · ↓ 5.5k tokens)',
        ].join('\n');
        const r = extractPtyStatusLine(buf);
        expect(r!.title).toBe('Refactoring auth middleware');
    });

    it('hash changes when any field changes, stays stable otherwise', () => {
        const a = { elapsedMs: 1000, tokens: 100, effort: 'max', title: 'X' };
        const b = { elapsedMs: 1000, tokens: 100, effort: 'max', title: 'X' };
        expect(ptyStatusLineHash(a)).toBe(ptyStatusLineHash(b));
        expect(ptyStatusLineHash({ ...a, tokens: 101 })).not.toBe(ptyStatusLineHash(a));
        expect(ptyStatusLineHash({ ...a, effort: 'high' })).not.toBe(ptyStatusLineHash(a));
    });
});
