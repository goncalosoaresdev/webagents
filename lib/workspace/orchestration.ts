import { z } from 'zod';

export const orchestrationSchema = z
  .object({
    worker: z
      .object({
        providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        model: z.string().trim().min(1).max(128),
        reasoningEffort: z.string().trim().min(1).max(32).optional(),
      })
      .strict(),
  })
  .strict();

/** Match only the mention being typed at the caret, not email addresses. */
export function providerMention(prompt: string, caret: number) {
  const match = /(?:^|\s)@([\w.-]*)$/.exec(prompt.slice(0, caret));
  return match
    ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
    : undefined;
}
