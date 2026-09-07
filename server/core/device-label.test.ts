import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLabel } from '../../lib/workspace/device-label.ts';
void test('labels the sending device without inventing a personal hostname', () => {
  assert.equal(deviceLabel('Mozilla Macintosh', 'MacIntel', 0), 'Mac');
  assert.equal(deviceLabel('Mozilla Macintosh', 'MacIntel', 5), 'iPad');
  assert.equal(deviceLabel('iPhone', 'iPhone', 5), 'iPhone');
  assert.equal(deviceLabel('Android Mobile'), 'Android phone');
  assert.equal(deviceLabel('Android'), 'Android tablet');
  assert.equal(deviceLabel('Windows NT'), 'Windows PC');
  assert.equal(deviceLabel('CrOS', 'Linux'), 'Chromebook');
  assert.equal(deviceLabel('Linux'), 'Linux PC');
  assert.equal(deviceLabel(''), 'This device');
});
