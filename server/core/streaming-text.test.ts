import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceText,
  revealBudget,
} from '../../lib/workspace/streaming-text.ts';

function simulate(text: string, hz: number) {
  let offset = 0;
  let budget = 0;
  let frames = 0;
  const positions: number[] = [];
  while (offset < text.length && frames < hz * 10) {
    budget += revealBudget(text.length - offset, 1000 / hz);
    if (budget >= 1) {
      const next = advanceText(text, offset, Math.floor(budget));
      budget = Math.max(0, budget - (next - offset));
      offset = next;
    }
    positions.push(offset);
    frames++;
  }
  return { offset, duration: (frames * 1000) / hz, positions };
}

void test('spreads a provider burst across frames and drains the exact response promptly', () => {
  const text = 'A response arriving in one burst. '.repeat(12);
  const result = simulate(text, 60);
  assert.equal(result.offset, text.length);
  assert.ok(result.positions[0] < text.length / 4);
  assert.ok(new Set(result.positions).size > 20);
  assert.ok(result.duration < 1200);
});
void test('pacing is consistent on 60Hz and 120Hz displays', () => {
  const text = 'Streaming text '.repeat(20);
  assert.ok(
    Math.abs(simulate(text, 60).duration - simulate(text, 120).duration) < 60,
  );
});
void test('never reveals half of an emoji, combining mark, or joined grapheme', () => {
  const text = '👩🏽‍💻e\u0301🇵🇹!';
  let offset = 0;
  for (const expected of ['👩🏽‍💻', '👩🏽‍💻e\u0301', '👩🏽‍💻e\u0301🇵🇹', text]) {
    offset = advanceText(text, offset, 1);
    assert.equal(text.slice(0, offset), expected);
  }
});
void test('a long background-tab pause does not create an unbounded reveal budget', () => {
  assert.equal(revealBudget(1000, 60000), revealBudget(1000, 64));
  assert.equal(revealBudget(1000, 0), 0);
});
void test('long unbroken text drains without waiting for a word boundary', () => {
  const result = simulate('x'.repeat(1000), 60);
  assert.ok(result.positions[0] > 0);
  assert.equal(result.offset, 1000);
  assert.ok(result.duration < 1500);
});
