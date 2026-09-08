import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { TurnResponse } from '../../components/conversation/turn-response.tsx';
import { OrchestrationComposer } from '../../components/conversation/orchestration-composer.tsx';
import { OrchestrationSelect } from '../../components/conversation/orchestration-select.tsx';
import type { Turn } from '../../lib/workspace/contracts.ts';

void test('renders persisted phase attribution and worker approvals without mixing provider answers', () => {
  const turn: Turn = {
    id: 't',
    taskId: 'task',
    prompt: 'do work',
    clientRequestId: 'request',
    status: 'running',
    createdAt: '2026-09-08T10:00:00Z',
    model: 'astra',
    orchestration: { worker: { providerId: 'muse', model: 'spark' } },
    executions: [
      {
        id: 'work',
        turnId: 't',
        phase: 'work',
        providerId: 'muse',
        model: 'spark',
        prompt: 'work',
        permissionMode: 'workspace',
        status: 'running',
        createdAt: '2026-09-08T10:00:00Z',
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(TurnResponse, {
      turn,
      onDecision: () => {},
      events: [
        {
          sequence: 3,
          taskId: 'task',
          turnId: 't',
          type: 'runtime.warning',
          data: { executionId: 'work', message: 'Muse is waiting on a tool.' },
          createdAt: turn.createdAt,
        },
        {
          sequence: 1,
          taskId: 'task',
          turnId: 't',
          type: 'agent.message.completed',
          data: {
            executionId: 'work',
            itemId: 'work:1',
            text: 'Worker result',
          },
          createdAt: turn.createdAt,
        },
        {
          sequence: 2,
          taskId: 'task',
          turnId: 't',
          type: 'agent.message.completed',
          data: {
            executionId: 'other',
            itemId: 'other:1',
            text: 'Unrelated result',
          },
          createdAt: turn.createdAt,
        },
      ],
      approvals: [
        {
          id: 'a',
          executionId: 'work',
          turnId: 't',
          taskId: 'task',
          kind: 'command',
          summary: 'muse · work: Run tests?',
          details: {},
          status: 'pending',
          createdAt: turn.createdAt,
        },
      ],
    }),
  );
  assert.match(html, /Muse is waiting on a tool/);
  assert.match(html, /Muse implementation/);
  assert.match(html, /Lead review/);
  assert.match(html, /Worker result/);
  assert.match(html, /muse · work: Run tests/);
  assert.match(html, /Allow once/);
  assert.doesNotMatch(html, /Unrelated result/);
});

void test('the strip indicator is display-only and glows only while a worker is armed', () => {
  const idle = renderToStaticMarkup(
    createElement(OrchestrationSelect, { providers: [] }),
  );
  assert.match(idle, /<output/);
  assert.match(idle, /Orchestration off/);
  assert.doesNotMatch(idle, /is-active/);
  assert.doesNotMatch(idle, /<button/);
  assert.doesNotMatch(idle, /orchestration-picker/);
  const armed = renderToStaticMarkup(
    createElement(OrchestrationSelect, {
      providers: [],
      orchestration: { worker: { providerId: 'muse', model: 'spark' } },
    }),
  );
  assert.match(armed, /is-active/);
  assert.match(armed, /Orchestration on/);
  assert.match(armed, /Spark/);
  assert.match(armed, /unavailable/);
  assert.doesNotMatch(armed, /<button/);
  assert.doesNotMatch(armed, /orchestration-picker/);
});

void test('the prompt composer keeps the message box while the worker control lives outside it', () => {
  const html = renderToStaticMarkup(
    createElement(OrchestrationComposer, {
      inputRef: { current: null },
      prompt: 'do not orchestrate this',
      onPrompt: () => {},
      onOrchestration: () => {},
      providers: [],
      leadLabel: 'GPT Astra',
      disabled: false,
      onSend: () => {},
    }),
  );
  assert.match(html, /<textarea/);
  assert.doesNotMatch(html, /orchestration-trigger/);
  assert.doesNotMatch(html, /Remove orchestration/);
});

void test('worker choices include every ready provider and format model slugs without changing IDs', async () => {
  const { modelDisplayName, workerChoices } =
    await import('../../lib/providers/display.ts');
  const providers = ['codex', 'muse', 'grok', 'unavailable'].map(
    (providerId) => ({
      providerId,
      health:
        providerId === 'unavailable'
          ? ('unavailable' as const)
          : ('ready' as const),
      checkedAt: 'now',
      models: [{ id: 'shared-id', label: 'Shared Model', capabilities: [] }],
    }),
  );
  const choices = workerChoices(providers, '');
  assert.deepEqual(
    choices.map((choice) => choice.providerId),
    ['codex', 'muse', 'grok'],
  );
  assert.equal(new Set(choices.map((choice) => choice.key)).size, 3);
  assert.equal(workerChoices(providers, 'grok shared')[0].providerId, 'grok');
  assert.equal(
    modelDisplayName({ id: 'muse-spark-1.3-contributor', label: '' }),
    'Muse Spark 1.3 Contributor',
  );
  assert.equal(
    modelDisplayName({ id: 'id', label: 'Custom Model Label' }),
    'Custom Model Label',
  );
  const html = renderToStaticMarkup(
    createElement(OrchestrationSelect, {
      providers,
      orchestration: { worker: { providerId: 'codex', model: 'shared-id' } },
    }),
  );
  assert.match(html, /Shared Model/);
  assert.doesNotMatch(html, /Model unavailable/);
  assert.match(html, /is-active/);
  assert.doesNotMatch(html, /<button/);
});
