import assert from 'node:assert/strict';
import test from 'node:test';
import { museEnvironment } from './client.ts';

void test('forwards Muse credentials and never the Webcode token', () => {
  const previous = process.env.WEBCODE_AUTH_TOKEN;
  process.env.WEBCODE_AUTH_TOKEN = 'server-secret';
  try {
    const env = museEnvironment('/srv/muse', {
      FIXTURE_MODE: 'normal',
      WEBCODE_AUTH_TOKEN: 'should-not-leak',
    });
    assert.equal(env.MUSE_HOME, '/srv/muse');
    assert.equal(env.FIXTURE_MODE, 'normal');
    assert.equal(env.WEBCODE_AUTH_TOKEN, undefined);
    assert.equal(env.MUSE_NO_AUTO_UPDATE, '1');
  } finally {
    if (previous === undefined) delete process.env.WEBCODE_AUTH_TOKEN;
    else process.env.WEBCODE_AUTH_TOKEN = previous;
  }
});
