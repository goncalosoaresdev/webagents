import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import {
  activityEdits,
  patchEdits,
  replacementDiff,
} from '../../lib/workspace/activity.ts';
import { buildTurnTimeline } from '../../lib/workspace/timeline.ts';
import {
  ActivityPreview,
  FileEditPreview,
} from '../../components/conversation/activity-preview.tsx';
import { itemEvent } from '../providers/muse/turn-runtime.ts';

void test('preserves Codex patches and ACP old/new text as readable edits', () => {
  assert.deepEqual(
    activityEdits({
      changes: [{ path: 'app.ts', diff: '@@ -1 +1 @@\n-old\n+new' }],
    }),
    [{ path: 'app.ts', diff: '@@ -1 +1 @@\n-old\n+new' }],
  );
  assert.deepEqual(
    activityEdits({
      content: [
        {
          type: 'diff',
          path: 'app.ts',
          oldText: 'same\nold\nend',
          newText: 'same\nnew\nend',
        },
      ],
    }),
    [{ path: 'app.ts', diff: ' same\n-old\n+new\n end' }],
  );
});
void test('Muse exposes edits while running and retains them on completion', () => {
  const item = {
    itemId: 'edit',
    revision: 1,
    kind: 'toolCall',
    status: 'inProgress',
    tool: 'edit',
    args: JSON.stringify({
      file_path: 'app.ts',
      old_string: 'old',
      new_string: 'new',
    }),
  };
  const started = itemEvent(item)!;
  const completed = itemEvent({ ...item, status: 'completed' })!;
  assert.deepEqual(started.data.edits, [
    { path: 'app.ts', diff: '-old\n+new' },
  ]);
  const timeline = buildTurnTimeline(
    [started, completed].map((event, sequence) => ({
      ...event,
      sequence,
      taskId: 'task',
      turnId: 'turn',
      createdAt: '',
    })),
  );
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, 'tool');
  if (timeline[0].kind === 'tool') {
    assert.equal(timeline[0].status, 'completed');
    assert.deepEqual(timeline[0].edits, started.data.edits);
  }
});
void test('parses multiple apply_patch files without mixing their contents', () => {
  const edits = patchEdits(
    '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+hello\n*** End Patch',
  );
  assert.deepEqual(edits, [
    { path: 'a.ts', diff: '@@\n-old\n+new' },
    { path: 'b.ts', diff: '+hello' },
  ]);
});
void test('bounds oversized diffs and labels their counts as partial', () => {
  const [edit] = activityEdits({
    changes: [{ path: 'large.ts', diff: '+line\n'.repeat(10000) }],
  });
  assert.equal(edit.diff.length, 24000);
  assert.equal(edit.truncated, true);
  const html = renderToStaticMarkup(createElement(FileEditPreview, { edit }));
  assert.match(html, /Partial preview/);
  assert.match(html, /View available diff/);
});
void test('shows additions/removals and preserves failed state without injecting provider HTML', () => {
  const html = renderToStaticMarkup(
    createElement(ActivityPreview, {
      tool: {
        id: 'a',
        kind: 'tool',
        sequence: 1,
        toolKind: 'fileChange',
        title: 'Edit',
        status: 'failed',
        files: [],
        edits: [{ path: 'app.ts', diff: '-old\n+<script>bad</script>' }],
      },
    }),
  );
  assert.match(html, /Not completed/);
  assert.match(html, /1 added, 1 removed/);
  assert.match(html, /diff-added/);
  assert.doesNotMatch(html, /<script>/);
});
void test('empty replacements render only actual added or removed lines', () => {
  assert.equal(replacementDiff('', 'new\n'), '+new');
  assert.equal(replacementDiff('old\n', ''), '-old');
  assert.deepEqual(activityEdits('{bad json'), []);
});
