const MAX_BRIEFING = 8_000;
const MAX_TURN = 1_400;

function clip(value: string, max: number) {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function handoffBriefing(input: {
  fromProvider: string;
  fromModel?: string;
  title: string;
  turns: readonly {
    userText: string;
    assistantText: string;
    error?: string;
  }[];
}): string {
  const recent = input.turns.slice(-6);
  const parts = [
    `This is a handoff from ${input.fromProvider}${input.fromModel ? ` (${input.fromModel})` : ''}.`,
    `Task: ${input.title.trim() || 'Untitled'}`,
    'Continue this work in the current project. Do not start over unless the previous result is unusable.',
  ];
  const last = recent.at(-1);
  if (last?.userText.trim()) {
    parts.push('## Latest request', clip(last.userText, MAX_TURN));
  }
  if (recent.length) {
    parts.push('## Conversation so far');
    for (const turn of recent) {
      if (turn.userText.trim())
        parts.push('### User', clip(turn.userText, MAX_TURN));
      if (turn.assistantText.trim())
        parts.push('### Agent', clip(turn.assistantText, MAX_TURN));
      if (turn.error?.trim()) parts.push('### Error', clip(turn.error, 600));
    }
  }
  return clip(parts.filter(Boolean).join('\n\n'), MAX_BRIEFING);
}
