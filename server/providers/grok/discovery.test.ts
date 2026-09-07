import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAccountLabel,
  parseAuthMethods,
  parseConfigOptions,
  parseGrokModels,
  parseGrokVersion,
  parseInitialize,
  reasoningCapability,
  selectAuthMethod,
} from './discovery.ts';

void test('normalizes Grok models and reasoning without leaking protocol fields', () => {
  assert.deepEqual(
    parseGrokModels({
      currentModelId: 'grok-4.6',
      availableModels: [
        { modelId: 'grok-4.6', name: 'Grok 4.6', extra: true },
        {
          modelId: 'grok-fast',
          name: 'Grok Fast',
          supportsReasoningEffort: false,
        },
      ],
    }),
    [
      {
        id: 'grok-4.6',
        label: 'Grok 4.6',
        isDefault: true,
        inputModalities: ['text', 'image'],
        capabilities: [reasoningCapability()],
      },
      {
        id: 'grok-fast',
        label: 'Grok Fast',
        isDefault: false,
        inputModalities: ['text', 'image'],
        capabilities: [],
      },
    ],
  );
});

void test('reads models and version from Grok initialize metadata', () => {
  const parsed = parseInitialize({
    protocolVersion: 1,
    authMethods: [{ id: 'cached_token', name: 'cached_token' }],
    _meta: {
      agentVersion: '1.0.13',
      modelState: {
        currentModelId: 'grok-4.6',
        availableModels: [
          {
            modelId: 'grok-4.6',
            name: 'Grok 4.6',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'high',
              reasoningEfforts: [
                { id: 'high', value: 'high', default: true },
                { id: 'low', value: 'low', default: false },
              ],
            },
          },
        ],
      },
    },
  });
  assert.equal(parsed.version, '1.0.13');
  assert.deepEqual(parsed.models, [
    {
      id: 'grok-4.6',
      label: 'Grok 4.6',
      isDefault: true,
      inputModalities: ['text', 'image'],
      capabilities: [reasoningCapability(['high', 'low'], 'high')],
    },
  ]);
  assert.equal(
    parseAccountLabel({
      _meta: { email: 'user@example.com', subscription_tier: 'SuperGrok' },
    }),
    'user@example.com',
  );
});

void test('rejects malformed model records', () => {
  assert.deepEqual(
    parseGrokModels({ availableModels: [{ name: 'Missing' }] }),
    [],
  );
  assert.deepEqual(parseGrokModels({ models: [{ id: '   ' }] }), []);
});

void test('reads session config options for model and effort', () => {
  assert.deepEqual(
    parseConfigOptions([
      {
        configId: 'model',
        value: { value: 'grok-4.6' },
        options: [{ value: 'grok-4.6' }, { id: 'grok-fast' }],
      },
      {
        configId: 'reasoning_effort',
        value: 'high',
        options: ['low', { value: 'high' }],
      },
    ]),
    {
      models: ['grok-4.6', 'grok-fast'],
      efforts: ['low', 'high'],
      currentModel: 'grok-4.6',
      currentEffort: 'high',
    },
  );
});

void test('extracts an installed Grok version from CLI output', () => {
  assert.equal(parseGrokVersion('grok 1.0.13'), '1.0.13');
  assert.equal(parseGrokVersion('Grok Build v1.2.0 (release)'), '1.2.0');
  assert.equal(parseGrokVersion('unknown'), undefined);
});

void test('selects a headless auth method and ignores browser-only options', () => {
  assert.equal(
    selectAuthMethod(
      [
        { id: 'browser', name: 'Browser' },
        { id: 'xai.api_key', name: 'API key' },
      ],
      { XAI_API_KEY: 'xai-test' },
    ),
    'xai.api_key',
  );
  assert.equal(
    selectAuthMethod([{ id: 'cached_token', name: 'Cached' }], {}),
    'cached_token',
  );
  assert.equal(
    selectAuthMethod([{ id: 'browser', name: 'Browser' }], {}),
    undefined,
  );
  assert.deepEqual(parseAuthMethods([{ id: 'cached_token', name: 'Cached' }]), [
    { id: 'cached_token', name: 'Cached' },
  ]);
});
