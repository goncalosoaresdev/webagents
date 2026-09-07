import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidBearerAuthorization } from './bearer-auth.ts';
import { InMemoryTicketStore } from './websocket-tickets.ts';

void test('bearer authentication requires the exact configured token', () => {
  const token = 'a'.repeat(32);
  assert.equal(isValidBearerAuthorization(`Bearer ${token}`, token), true);
  assert.equal(
    isValidBearerAuthorization(`Bearer ${'b'.repeat(32)}`, token),
    false,
  );
  assert.equal(isValidBearerAuthorization(`Basic ${token}`, token), false);
  assert.equal(isValidBearerAuthorization(undefined, token), false);
});

void test('websocket tickets are short-lived and single use', () => {
  let now = 1_000;
  const tickets = new InMemoryTicketStore({ ttlMs: 5_000, now: () => now });
  const first = tickets.issue();
  assert.equal(tickets.consume(first.token), true);
  assert.equal(tickets.consume(first.token), false);

  const expired = tickets.issue();
  now = 6_001;
  assert.equal(tickets.consume(expired.token), false);
});

void test('websocket ticket storage stays bounded', () => {
  const tickets = new InMemoryTicketStore({
    ttlMs: 5_000,
    maxTickets: 2,
    now: () => 1_000,
  });
  const oldest = tickets.issue();
  const retained = tickets.issue();
  const newest = tickets.issue();
  assert.equal(tickets.consume(oldest.token), false);
  assert.equal(tickets.consume(retained.token), true);
  assert.equal(tickets.consume(newest.token), true);
});
