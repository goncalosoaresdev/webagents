/** Hold only the unfinished trailing word; never alter the canonical response. */
export function completeWordPrefix(text: string): string {
  return text.replace(/\S+$/u, '');
}
