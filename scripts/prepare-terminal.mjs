// node-pty's macOS prebuilt spawn helper can arrive without its executable bit.
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const file of [join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'), join(root, 'build/Release/spawn-helper')]) {
    if (existsSync(file)) chmodSync(file, 0o755);
  }
}
