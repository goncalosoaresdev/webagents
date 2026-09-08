import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { SpeechProvider } from './provider.ts';
import type {
  SpeechSettings,
  SpeechPreferences,
} from '../../lib/speech/contracts.ts';
import { InMemoryTicketStore } from '../security/websocket-tickets.ts';
export const speechPreferences = z
  .object({
    enabled: z.array(z.string().max(64)).max(32),
    activeProvider: z.string().max(64).nullable(),
  })
  .strict();
export class SpeechService {
  readonly tickets = new InMemoryTicketStore({ ttlMs: 30_000 });
  private preferences: SpeechPreferences = {
    enabled: [],
    activeProvider: null,
  };
  readonly providers: Map<string, SpeechProvider>;
  constructor(
    providers: SpeechProvider[],
    private readonly path?: string,
  ) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
    if (path) {
      try {
        this.preferences = speechPreferences.parse(
          JSON.parse(readFileSync(path, 'utf8')),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  read(): SpeechSettings {
    return {
      ...this.preferences,
      providers: [...this.providers.values()].map(
        ({ id, name, configured, realtime }) => ({
          id,
          name,
          configured,
          realtime,
        }),
      ),
    };
  }
  update(input: SpeechPreferences) {
    const next = speechPreferences.parse(input);
    if (
      next.enabled.some((id) => !this.providers.has(id)) ||
      (next.activeProvider && !next.enabled.includes(next.activeProvider))
    )
      throw new Error('Select an enabled speech provider.');
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path + '.tmp', JSON.stringify(next), { mode: 0o600 });
      renameSync(this.path + '.tmp', this.path);
    }
    this.preferences = next;
    return this.read();
  }
  active() {
    const id = this.preferences.activeProvider;
    const provider =
      id && this.preferences.enabled.includes(id)
        ? this.providers.get(id)
        : undefined;
    if (!provider?.configured)
      throw new Error('Enable a configured speech provider in Settings first.');
    return provider;
  }
}
