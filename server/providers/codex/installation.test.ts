import test from 'node:test';
import assert from 'node:assert/strict';
import { isHomebrewCodex } from './installation.ts';
void test('recognizes only the executable inside the exact Homebrew Codex cask', () => {
  const root = '/opt/homebrew/Caskroom/codex';
  assert.equal(isHomebrewCodex(`${root}/0.152.0/bin/codex`, root), true);
  assert.equal(isHomebrewCodex(`${root}-other/0.152.0/bin/codex`, root), false);
  assert.equal(isHomebrewCodex(`${root}/0.152.0/bin/custom`, root), false);
  assert.equal(
    isHomebrewCodex('/Applications/Codex.app/Contents/MacOS/codex', root),
    false,
  );
  assert.equal(isHomebrewCodex(`${root}/../other/bin/codex`, root), false);
});
