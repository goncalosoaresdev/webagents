import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseMuseCatalog,
  parseMuseVersion,
  reasoningCapability,
} from './discovery.ts';

void test('keeps Meta models and attaches reasoning without leaking protocol fields', () => {
  assert.deepEqual(
    parseMuseCatalog({
      source: 'providerCatalog',
      providerId: 'meta',
      profileId: null,
      models: [
        {
          modelId: 'muse-spark-1.3',
          displayLabel: 'Muse Spark 1.3',
          providerId: 'meta',
          isDefault: true,
          extra: true,
        },
        {
          modelId: 'echo',
          displayLabel: 'Echo',
          providerId: 'echo',
          isDefault: false,
        },
      ],
    }),
    [
      {
        id: 'muse-spark-1.3',
        label: 'Muse Spark 1.3',
        isDefault: true,
        inputModalities: ['text', 'image'],
        capabilities: [reasoningCapability()],
      },
    ],
  );
});

void test('rejects malformed model catalogs', () => {
  assert.throws(() => parseMuseCatalog({ models: [] }));
  assert.throws(() =>
    parseMuseCatalog({
      source: 'providerCatalog',
      providerId: 'meta',
      models: [{ displayLabel: 'Missing identifier' }],
    }),
  );
});

void test('extracts an installed Muse version from CLI output', () => {
  assert.equal(parseMuseVersion('Muse Code 1.0.3 (1.0.3-R2198.1)'), '1.0.3');
  assert.equal(parseMuseVersion('muse 0.9.0'), '0.9.0');
  assert.equal(parseMuseVersion('unknown'), undefined);
});
