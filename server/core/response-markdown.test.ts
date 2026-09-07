import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { ResponseMarkdown } from '../../components/conversation/response-markdown.tsx';

void test('renders structured responses with lists, inline code, tables, and scrollable code blocks', () => {
  const html = renderToStaticMarkup(
    createElement(ResponseMarkdown, {
      text: '# Repositories\n\n- **app**: `main`\n- docker: `main`\n\n| Project | Branch |\n| --- | --- |\n| app | main |\n\n```ts\nconst value = 1;\n```',
    }),
  );
  assert.match(html, /<h1>Repositories<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>app<\/strong>/);
  assert.match(html, /<code>main<\/code>/);
  assert.match(html, /class="response-table"/);
  assert.match(html, /<table>/);
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /class="language-ts"/);
});
void test('does not execute raw HTML, unsafe links, or load remote images from provider text', () => {
  const html = renderToStaticMarkup(
    createElement(ResponseMarkdown, {
      text: '<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n![Image](https://example.com/pixel.png)\n\n[safe](https://example.com)',
    }),
  );
  assert.doesNotMatch(html, /<script|javascript:|<img/);
  assert.match(html, /rel="noopener noreferrer"/);
});
void test('renders incomplete streamed Markdown without throwing', () => {
  const html = renderToStaticMarkup(
    createElement(ResponseMarkdown, {
      text: 'Working on **this\n\n```ts\nconst result =',
    }),
  );
  assert.match(html, /const result =/);
});
