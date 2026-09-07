import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.ts';

void test('loads and normalizes explicit production configuration', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    WEBCODE_AUTH_TOKEN: 'test-only-token-'.repeat(3),
    WEBCODE_ALLOWED_ORIGINS: 'https://one.example.com, https://two.example.com',
    WEBCODE_WORKSPACE_ROOT: process.cwd(),
    MUSE_BIN: '/opt/muse',
  });

  assert.equal(config.environment, 'production');
  assert.equal(config.allowedOrigins.has('https://two.example.com'), true);
  assert.equal(config.workspaceRoot, process.cwd());
  assert.equal(config.muse.binaryPath, '/opt/muse');
});

void test('requires an explicit browser origin in production', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production' }),
    /WEBCODE_ALLOWED_ORIGINS is required in production/,
  );
});

void test('rejects origins containing paths or non-HTTP schemes', () => {
  assert.throws(
    () =>
      loadConfig({
        WEBCODE_ALLOWED_ORIGINS: 'https://webcode.example.com/path',
      }),
    /WEBCODE_ALLOWED_ORIGINS contains/,
  );
});

void test('requires authentication in production and on public interfaces', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        WEBCODE_ALLOWED_ORIGINS: 'https://example.com',
      }),
    /WEBCODE_AUTH_TOKEN/,
  );
  assert.throws(
    () => loadConfig({ WEBCODE_HOST: '0.0.0.0' }),
    /WEBCODE_AUTH_TOKEN/,
  );
  assert.equal(loadConfig({}).authToken, undefined);
});
