import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type {
  TerminalSession,
  TerminalOutput,
} from '../../lib/workspace/terminal.ts';
import { ConflictError, ResourceNotFoundError } from '../storage/errors.ts';
const { Terminal } = headless;
export type PtyFactory = (cwd: string) => pty.IPty;
function spawnShell(cwd: string): pty.IPty {
  const shell = userInfo().shell || '/bin/sh';
  const env: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'SHELL',
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return pty.spawn(shell, ['-l'], {
    cwd,
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    env,
  });
}
interface Session {
  info: TerminalSession;
  process: pty.IPty;
  screen: InstanceType<typeof Terminal>;
  serialize: InstanceType<typeof SerializeAddon>;
  listeners: Set<(event: TerminalOutput) => void>;
  pending: number;
  connections: number;
  disposed: boolean;
}
export class TerminalService {
  private sessions = new Map<string, Session>();
  private tickets = new Map<string, { id: string; expires: number }>();
  private closed = false;
  constructor(
    private readonly projectPath: (id: string) => string,
    private readonly factory: PtyFactory = spawnShell,
  ) {}
  list(projectId: string): TerminalSession[] {
    this.projectPath(projectId);
    return [...this.sessions.values()]
      .filter((s) => s.info.projectId === projectId)
      .map((s) => ({ ...s.info }));
  }
  create(projectId: string, id: string): TerminalSession {
    if (this.closed) throw new ConflictError('Server is shutting down.');
    const cwd = this.projectPath(projectId);
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.info.projectId !== projectId)
        throw new ConflictError('Terminal belongs to a different project.');
      return { ...existing.info };
    }
    if (this.sessions.size >= 12 || this.list(projectId).length >= 4)
      throw new ConflictError(
        'Terminal limit reached. End an existing terminal first.',
      );
    const process = this.factory(cwd);
    const screen = new Terminal({
      cols: 100,
      rows: 28,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    screen.loadAddon(serialize);
    const session: Session = {
      info: {
        id,
        projectId,
        name: `Terminal ${this.list(projectId).length + 1}`,
        status: 'running',
        createdAt: new Date().toISOString(),
      },
      process,
      screen,
      serialize,
      listeners: new Set(),
      pending: 0,
      connections: 0,
      disposed: false,
    };
    this.sessions.set(id, session);
    process.onData((data) => {
      if (session.disposed) return;
      session.pending += data.length;
      if (session.pending > 256000) process.pause();
      screen.write(data, () => {
        if (session.disposed) return;
        session.pending -= data.length;
        if (session.pending < 64000 && session.info.status === 'running')
          process.resume();
        this.emit(session, { type: 'output', data });
      });
    });
    process.onExit(({ exitCode }) => {
      if (session.disposed) return;
      session.info = { ...session.info, status: 'exited', exitCode };
      screen.write('', () => {
        if (!session.disposed) this.emit(session, { type: 'exit', exitCode });
      });
    });
    return { ...session.info };
  }
  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new ResourceNotFoundError('Terminal', id);
    return session;
  }
  private emit(session: Session, event: TerminalOutput) {
    for (const listener of session.listeners) listener(event);
  }
  attach(id: string, listener: (event: TerminalOutput) => void): () => void {
    const session = this.get(id);
    if (session.connections >= 4)
      throw new ConflictError('Too many terminal connections.');
    session.connections++;
    let cancelled = false;
    // Snapshot and live subscription share the parser queue: no replay/live gap.
    session.screen.write('', () => {
      if (cancelled || session.disposed) return;
      session.listeners.add(listener);
      listener({
        type: 'snapshot',
        data: session.serialize.serialize(),
        cols: session.screen.cols,
        rows: session.screen.rows,
        status: session.info.status,
      });
    });
    return () => {
      if (cancelled) return;
      cancelled = true;
      session.connections--;
      session.listeners.delete(listener);
    };
  }
  write(id: string, data: string) {
    const s = this.get(id);
    if (s.info.status === 'running') s.process.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    const s = this.get(id);
    if (s.screen.cols === cols && s.screen.rows === rows) return;
    s.screen.resize(cols, rows);
    if (s.info.status === 'running') s.process.resize(cols, rows);
    this.emit(s, { type: 'resize', cols, rows });
  }
  ticket(id: string) {
    this.get(id);
    for (const [key, value] of this.tickets)
      if (value.expires <= Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 128)
      throw new ConflictError('Too many pending connections.');
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(token, { id, expires: Date.now() + 30000 });
    return { token };
  }
  consumeTicket(token: string, id: string): boolean {
    const entry = this.tickets.get(token);
    this.tickets.delete(token);
    return (
      !!entry &&
      entry.id === id &&
      entry.expires > Date.now() &&
      this.sessions.has(id)
    );
  }
  end(id: string) {
    const session = this.get(id);
    session.disposed = true;
    this.emit(session, { type: 'exit', exitCode: -1 });
    session.listeners.clear();
    if (session.info.status === 'running') session.process.kill();
    session.screen.dispose();
    this.sessions.delete(id);
    for (const [token, entry] of this.tickets)
      if (entry.id === id) this.tickets.delete(token);
  }
  close() {
    this.closed = true;
    for (const id of this.sessions.keys()) this.end(id);
    this.tickets.clear();
  }
}
