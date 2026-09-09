import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { TurnResponse } from '../../components/conversation/turn-response.tsx';
import { buildTurnTimeline } from '../../lib/workspace/timeline.ts';
import { completeWordPrefix } from '../../lib/workspace/streaming-text.ts';
import type { TaskEvent, Turn } from '../../lib/workspace/contracts.ts';

const turn: Turn = { id: 't', taskId: 'task', prompt: 'work', clientRequestId: 'r', status: 'running', createdAt: '2026-09-09T10:00:00Z' };
const events: TaskEvent[] = [{ sequence: 1, taskId: 'task', turnId: 't', createdAt: turn.createdAt, type: 'activity.started', data: { itemId: 'tool', title: 'Read source', detail: 'cat app.ts', status: 'in_progress', output: 'source preview' } }];
void test('shows activity previews while running and collapses them even without a final answer', () => {
  const render = (status: Turn['status']) => renderToStaticMarkup(createElement(TurnResponse, { turn: { ...turn, status }, events, approvals: [], onDecision() {} }));
  const active = render('running');
  assert.match(active, /aria-label="Live tool activity"/);
  assert.match(active, /cat app.ts/);
  assert.match(active, /source preview/);
  for (const status of ['completed', 'interrupted', 'failed'] as const) {
    const html = render(status);
    assert.doesNotMatch(html, /aria-label="Live tool activity"/);
    assert.match(html, /<details class="tool-group/);
  }
});
void test('normalizes running states and preserves tool details across updates', () => {
  const result = buildTurnTimeline([...events, { ...events[0], sequence: 2, data: { itemId: 'tool', output: 'new output', status: 'pending' } }]);
  assert.equal(result[0].kind, 'tool');
  if (result[0].kind !== 'tool') return;
  assert.equal(result[0].status, 'inProgress');
  assert.equal(result[0].detail, 'cat app.ts');
  assert.equal(result[0].output, 'new output');
});
void test('buffers partial words while preserving whitespace, Unicode and Markdown', () => {
  assert.equal(completeWordPrefix('Hel'), '');
  assert.equal(completeWordPrefix('Hello wor'), 'Hello ');
  assert.equal(completeWordPrefix('Hello world\n'), 'Hello world\n');
  assert.equal(completeWordPrefix('Olá 👋 mun'), 'Olá 👋 ');
  assert.equal(completeWordPrefix('```ts\nconst val'), '```ts\nconst ');
});
void test('completion replaces deltas exactly and marks the message ready to flush', () => {
  const result = buildTurnTimeline([{ ...events[0], type: 'agent.message.delta', data: { itemId: 'm', text: 'Par' } }, { ...events[0], sequence: 2, type: 'agent.message.completed', data: { itemId: 'm', text: 'Final response.' } }]);
  assert.deepEqual(result[0], { kind: 'message', id: 'm', sequence: 1, text: 'Final response.', completed: true });
});

void test('one failed tool does not label the entire group as failed', () => {
  const mixed = [
    { ...events[0], type: 'activity.completed' as const, data: { itemId: 'one', title: 'Read', status: 'completed' } },
    { ...events[0], sequence: 2, type: 'activity.completed' as const, data: { itemId: 'two', title: 'Search', status: 'failed' } },
  ];
  const html = renderToStaticMarkup(createElement(TurnResponse, { turn: { ...turn, status: 'interrupted' }, events: mixed, approvals: [], onDecision() {} }));
  assert.match(html, /Used 2 tools · 1 failed/);
  assert.doesNotMatch(html, /Failed 2 tools/);
});
