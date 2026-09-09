import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { ApprovalCard } from '../../components/conversation/approval-card.tsx';
import type { ApprovalRequest } from '../../lib/workspace/contracts.ts';

const request: ApprovalRequest = {
  id: 'a',
  taskId: 't',
  turnId: 'r',
  kind: 'command',
  status: 'pending',
  summary: 'Run the build to validate changes.',
  details: { command: 'npm run build', cwd: '/workspace/app' },
  createdAt: '2026-09-09T00:00:00Z',
};
const render = (approval = request) =>
  renderToStaticMarkup(
    createElement(ApprovalCard, { approval, onDecision() {} }),
  );
void test('separates command, directory, reason and request-scoped actions', () => {
  const html = render();
  assert.match(html, /Allow this action\?/);
  assert.match(html, /<pre class="approval-command">npm run build<\/pre>/);
  assert.match(html, /\/workspace\/app/);
  assert.match(html, /Run the build to validate changes\./);
  assert.doesNotMatch(html, /Your turn|Applies to this request only/);
  assert.match(html, /Allow once/);
  assert.match(html, /Decline/);
});
void test('respects provider decision capabilities', () => {
  const html = render({
    ...request,
    details: { supportedDecisions: ['cancel'] },
  });
  assert.match(html, /Cancel/);
  assert.doesNotMatch(html, /Allow once|Decline/);
});
void test('shows file paths and safely renders provider text', () => {
  const html = render({
    ...request,
    kind: 'fileChange',
    summary: '<script>bad</script>',
    details: { path: '/workspace/file.ts' },
  });
  assert.match(html, /Allow file access\?/);
  assert.match(html, /\/workspace\/file.ts/);
  assert.doesNotMatch(html, /<script>/);
});

void test('extracts readable action and description from Muse JSON summaries', () => {
  const html = render({
    ...request,
    summary:
      'network: ' +
      JSON.stringify({
        command: 'git push origin main',
        description: 'Push changes',
        yield_time_ms: 120000,
      }),
    details: { toolName: 'network' },
  });
  assert.match(html, /Push changes/);
  assert.match(
    html,
    /<pre class="approval-command">git push origin main<\/pre>/,
  );
  assert.doesNotMatch(html, /yield_time_ms|network:/);
});
