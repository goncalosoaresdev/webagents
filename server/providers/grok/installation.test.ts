import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrokVersion } from './discovery.ts';

void test('parses Grok Build version strings used by installation inspect', () => {
  assert.equal(parseGrokVersion('grok 1.0.13\n'), '1.0.13');
  assert.equal(parseGrokVersion('xai-grok-pager 0.9.0'), '0.9.0');
});
