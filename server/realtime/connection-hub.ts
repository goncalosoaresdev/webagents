import type { ProviderSnapshot } from '../../lib/providers/contracts.ts';
import type { TaskEvent } from '../../lib/workspace/contracts.ts';

export interface RealtimeConnection {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export class ConnectionHub {
  readonly #connections = new Set<RealtimeConnection>();

  add(connection: RealtimeConnection): () => void {
    this.#connections.add(connection);
    return () => this.#connections.delete(connection);
  }

  broadcastProviderSnapshot(snapshot: ProviderSnapshot): void {
    this.broadcast({ type: 'provider.snapshot', data: snapshot });
  }

  broadcastTaskEvent(event: TaskEvent): void {
    this.broadcast({ type: 'task.event', data: event });
  }

  broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const connection of this.#connections) {
      if (connection.readyState !== OPEN) continue;
      try {
        if ((connection.bufferedAmount ?? 0) > 1024 * 1024) {
          this.#connections.delete(connection);
          connection.close(1013, 'Reconnect to recover events');
          continue;
        }
        connection.send(payload);
      } catch {
        this.#connections.delete(connection);
        connection.close(1011, 'Realtime delivery failed');
      }
    }
  }

  closeAll(): void {
    for (const connection of this.#connections)
      connection.close(1001, 'Server shutting down');
    this.#connections.clear();
  }
}
