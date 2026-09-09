/** Provider-neutral, bounded previews. These describe provider events, never filesystem guesses. */
export interface FileEdit {
  path: string;
  diff: string;
  truncated?: boolean;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
export function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}
function bounded(path: string, diff: string): FileEdit {
  return {
    path: path.slice(0, 2000),
    diff: diff.slice(0, 24000),
    ...(diff.length > 24000 ? { truncated: true } : {}),
  };
}

/** Trim unchanged prefix/suffix; replacement regions remain exact, not a guessed line-by-line match. */
export function replacementDiff(before: string, after: string): string {
  const oldLines = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const newLines = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start++;
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
  )
    end++;
  const contextStart = Math.max(0, start - 2);
  return [
    ...oldLines.slice(contextStart, start).map((line) => ` ${line}`),
    ...oldLines.slice(start, oldLines.length - end).map((line) => `-${line}`),
    ...newLines.slice(start, newLines.length - end).map((line) => `+${line}`),
    ...oldLines
      .slice(oldLines.length - end, oldLines.length - end + Math.min(end, 2))
      .map((line) => ` ${line}`),
  ].join('\n');
}

export function patchEdits(patch: string): FileEdit[] {
  const edits: FileEdit[] = [];
  let path = '';
  let lines: string[] = [];
  const flush = () => {
    if (path) edits.push(bounded(path, lines.join('\n')));
    lines = [];
  };
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header || gitHeader) {
      flush();
      path = header?.[1] ?? gitHeader![2];
    } else if (line.startsWith('+++ ') && !path)
      path = line.slice(4).replace(/^b\//, '');
    else if (/^(?:@@|[ +-])/.test(line) && !/^(?:--- |\+\+\+ )/.test(line))
      lines.push(line);
  }
  flush();
  return edits.slice(0, 50);
}

export function activityEdits(value: unknown): FileEdit[] {
  const source = toolArguments(value);
  const changes = Array.isArray(source.changes) ? source.changes : [];
  const content = Array.isArray(source.content) ? source.content : [];
  const edits: FileEdit[] = [];
  for (const entry of [...changes, ...content]) {
    const change = record(entry);
    const path = string(change.path);
    if (!path) continue;
    if (typeof change.diff === 'string') edits.push(bounded(path, change.diff));
    else if (typeof change.newText === 'string')
      edits.push(
        bounded(path, replacementDiff(string(change.oldText), change.newText)),
      );
  }
  const path = string(source.file_path) || string(source.path);
  const before = source.old_string ?? source.oldText;
  const after = source.new_string ?? source.newText;
  if (path && typeof before === 'string' && typeof after === 'string')
    edits.push(bounded(path, replacementDiff(before, after)));
  const patch = string(source.patch) || string(source.input);
  if (patch) edits.push(...patchEdits(patch));
  return edits.slice(0, 50);
}

export function readFileEdits(value: unknown): FileEdit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 50).flatMap((entry) => {
    const edit = record(entry);
    return typeof edit.path === 'string' && typeof edit.diff === 'string'
      ? [
          {
            ...bounded(edit.path, edit.diff),
            ...(edit.truncated === true ? { truncated: true } : {}),
          },
        ]
      : [];
  });
}
