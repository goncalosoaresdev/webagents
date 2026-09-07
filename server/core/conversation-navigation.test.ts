import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeStopIndex,
  visibleStopIndices,
  conversationStops,
  previewText,
} from '../../lib/workspace/conversation-navigation.ts';
import type { TaskDetail } from '../../lib/workspace/contracts.ts';
void test('reading position selects the current exchange at boundaries', () => {
  assert.equal(activeStopIndex([], 0), -1);
  assert.equal(activeStopIndex([100, 300, 800], 0), 0);
  assert.equal(activeStopIndex([100, 300, 800], 299), 0);
  assert.equal(activeStopIndex([100, 300, 800], 300), 1);
  assert.equal(activeStopIndex([100, 300, 800], 9999), 2);
});
void test('previews remove markdown syntax without rendering HTML', () => {
  assert.equal(
    previewText('## Created [pages](https://example.com) with `code`'),
    'Created pages with code',
  );
  assert.equal(
    previewText('<script>alert(1)</script>').includes('<script'),
    true,
  );
});
void test('navigation follows turn order, uses completed output and handles attachments', () => {
  const detail = {
    turns: [
      { id: 'a', prompt: 'First', status: 'completed' },
      {
        id: 'b',
        prompt: '',
        status: 'running',
        attachments: [{ name: 'image.png' }],
      },
    ],
    events: [
      { turnId: 'a', type: 'agent.message.delta', data: { delta: 'partial' } },
      {
        turnId: 'a',
        type: 'agent.message.completed',
        data: { text: 'Final answer' },
      },
    ],
  } as unknown as TaskDetail;
  const stops = conversationStops(detail);
  assert.deepEqual(
    stops.map((s) => s.id),
    ['a', 'b'],
  );
  assert.equal(stops[0]?.preview, 'Final answer');
  assert.equal(stops[1]?.title, 'image.png');
  assert.match(stops[1]!.preview, /Working/);
  assert.deepEqual(conversationStops(undefined), []);
});

void test('all exchanges intersecting the reading viewport are highlighted', () => {
  const ranges = [
    { top: -100, bottom: 80 },
    { top: 100, bottom: 250 },
    { top: 300, bottom: 500 },
    { top: 550, bottom: 800 },
  ];
  assert.deepEqual(visibleStopIndices(ranges, 0, 400), [0, 1, 2]);
  // The composer hides everything below 300; touching an edge is not visible.
  assert.deepEqual(visibleStopIndices(ranges, 80, 300), [1]);
  assert.deepEqual(visibleStopIndices(ranges, 260, 290), []);
});
void test('visibility handles long exchanges, missing elements and empty viewports', () => {
  assert.deepEqual(
    visibleStopIndices([{ top: -1000, bottom: 2000 }], 0, 500),
    [0],
  );
  assert.deepEqual(
    visibleStopIndices(
      [
        { top: Infinity, bottom: Infinity },
        { top: 10, bottom: 10 },
      ],
      0,
      500,
    ),
    [],
  );
  assert.deepEqual(visibleStopIndices([], 0, 500), []);
  assert.deepEqual(visibleStopIndices([{ top: 0, bottom: 500 }], 100, 100), []);
});
