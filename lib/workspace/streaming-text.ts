/** Retained for callers that need a complete-word preview. */
export function completeWordPrefix(text: string): string {
  return text.replace(/\S+$/u, '');
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Frame-rate-independent reveal budget. Catch up bursts with ~160ms time constant. */
export function revealBudget(pending: number, elapsedMs: number): number {
  const elapsed = Math.max(0, Math.min(elapsedMs, 64));
  return Math.max(
    (45 * elapsed) / 1000,
    pending * (1 - Math.exp(-elapsed / 160)),
  );
}

/** Advance only across complete graphemes, including joined emoji and combining marks. */
export function advanceText(
  target: string,
  offset: number,
  budget: number,
): number {
  let end = offset;
  for (const part of graphemes.segment(target.slice(offset))) {
    if (part.index >= budget) break;
    end = offset + part.index + part.segment.length;
  }
  return end;
}
