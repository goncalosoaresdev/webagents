import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexVersion, parseModel } from './discovery.ts';

void test('normalizes Codex model capabilities without leaking protocol fields', () => {
  assert.deepEqual(
    parseModel({
      model: 'gpt-example',
      displayName: 'GPT Example',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' },
      ],
      defaultServiceTier: 'fast',
      serviceTiers: [
        { id: 'fast', name: 'Fast', description: 'Lower latency' },
      ],
      unknownFutureField: { should: 'be ignored' },
    }),
    {
      id: 'gpt-example',
      isDefault: false,
      label: 'GPT Example',
      capabilities: [
        {
          id: 'reasoningEffort',
          label: 'Reasoning',
          defaultValue: 'high',
          values: [
            { id: 'low', label: 'Low', isDefault: false },
            { id: 'high', label: 'High', isDefault: true },
          ],
        },
        {
          id: 'serviceTier',
          label: 'Service tier',
          defaultValue: 'fast',
          values: [
            { id: 'default', label: 'Standard', isDefault: false },
            {
              id: 'fast',
              label: 'Fast',
              description: 'Lower latency',
              isDefault: true,
            },
          ],
        },
      ],
    },
  );
});

void test('rejects malformed model records', () => {
  assert.equal(parseModel({ displayName: 'Missing identifier' }), null);
  assert.equal(parseModel({ model: '   ' }), null);
});

void test('extracts an installed Codex version from initialize metadata', () => {
  assert.equal(
    parseCodexVersion(
      'Codex Desktop/0.152.0 (Linux; x86_64) dumb (webcode; 0.1.0)',
    ),
    '0.152.0',
  );
  assert.equal(parseCodexVersion('unknown client'), undefined);
});
