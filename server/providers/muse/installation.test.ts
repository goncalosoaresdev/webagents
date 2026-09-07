import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MuseInstallation } from './installation.ts';

void test('inspects a Muse binary and never offers in-app updates', async (context: TestContext) => {
  const cwd = await mkdtemp(join(tmpdir(), 'webcode-muse-install-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const binaryPath = join(cwd, 'muse');
  await writeFile(
    binaryPath,
    `#!${process.execPath}\nprocess.stdout.write('Muse Code 1.0.3 (1.0.3-R2198.1)\\n');\n`,
    { mode: 0o700 },
  );
  const driver = new MuseInstallation(binaryPath);
  const inspected = await driver.inspect();
  assert.equal(inspected.version, '1.0.3');
  assert.equal(inspected.canUpdate, false);
  assert.match(inspected.message ?? '', /official installer|outside Webcode/);
  assert.equal(await driver.latest(), '1.0.3');
  await assert.rejects(driver.update(), /Unsupported/);
});

void test('reports a missing Muse installation without throwing on inspect', async () => {
  const driver = new MuseInstallation('/missing/muse-binary');
  const inspected = await driver.inspect();
  assert.equal(inspected.version, undefined);
  assert.equal(inspected.canUpdate, false);
  assert.match(inspected.message ?? '', /not installed/);
});
