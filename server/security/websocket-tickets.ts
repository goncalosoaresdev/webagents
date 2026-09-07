import { randomBytes } from 'node:crypto';

export interface WebSocketTicket {
  token: string;
  expiresAt: string;
}

export interface TicketStore {
  issue(): WebSocketTicket;
  consume(token: string): boolean;
}

interface TicketRecord {
  expiresAt: number;
  sequence: number;
}

export class InMemoryTicketStore implements TicketStore {
  readonly #tickets = new Map<string, TicketRecord>();
  readonly #ttlMs: number;
  readonly #maxTickets: number;
  readonly #now: () => number;
  #sequence = 0;

  constructor(options: {
    ttlMs: number;
    maxTickets?: number;
    now?: () => number;
  }) {
    this.#ttlMs = options.ttlMs;
    this.#maxTickets = options.maxTickets ?? 1_024;
    this.#now = options.now ?? Date.now;
  }

  issue(): WebSocketTicket {
    this.#prune();
    while (this.#tickets.size >= this.#maxTickets) {
      const oldest = [...this.#tickets.entries()].reduce((left, right) =>
        left[1].sequence < right[1].sequence ? left : right,
      );
      this.#tickets.delete(oldest[0]);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tickets.set(token, { expiresAt, sequence: this.#sequence++ });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token: string): boolean {
    const record = this.#tickets.get(token);
    if (!record) return false;
    this.#tickets.delete(token);
    return record.expiresAt > this.#now();
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, record] of this.#tickets) {
      if (record.expiresAt <= now) this.#tickets.delete(token);
    }
  }
}
