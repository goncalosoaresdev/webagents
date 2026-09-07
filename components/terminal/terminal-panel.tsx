'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, TerminalSquare, X, ChevronDown } from 'lucide-react';

import {
  terminalDimensions,
  terminalCloseMessage,
} from '@/lib/workspace/terminal-connection';
import type { WebcodeApi } from '@/lib/api/client';
import type { TerminalSession, TerminalOutput } from '@/lib/workspace/terminal';

function TerminalView({
  api,
  id,
  onExit,
}: {
  api: WebcodeApi;
  id: string;
  onExit: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const exitCallback = useRef(onExit);
  useEffect(() => {
    exitCallback.current = onExit;
  }, [onExit]);
  const [status, setStatus] = useState('Connecting…');
  useEffect(() => {
    let disposed = false,
      socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout>,
      observer: ResizeObserver | undefined;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    let fit: import('@xterm/addon-fit').FitAddon | undefined;
    let ready = false,
      attempt = 0,
      unparsed = 0;
    const send = (message: unknown) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    function resize() {
      if (!ready || !terminal || !fit || !element.current?.clientWidth) return;
      const size = terminalDimensions(fit.proposeDimensions());
      if (!size) return;
      const cols = Math.max(20, Math.min(300, size.cols)),
        rows = Math.max(5, Math.min(100, size.rows));
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
        send({ type: 'resize', cols, rows });
      }
    }
    async function connect() {
      if (disposed) return;
      ready = false;
      try {
        const ticket = await api.terminalTicket(id);
        if (disposed) return;
        const url = new URL('/terminal-ws', window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('id', id);
        url.searchParams.set('ticket', ticket.token);
        const current = new WebSocket(url);
        socket = current;
        current.onmessage = (event) => {
          if (disposed || current !== socket || !terminal) return;
          const message = JSON.parse(event.data) as TerminalOutput;
          if (message.type === 'snapshot' || message.type === 'output') {
            unparsed += message.data.length;
            if (unparsed > 8_000_000) {
              current.close();
              return;
            }
            if (message.type === 'snapshot') {
              terminal.reset();
              terminal.resize(message.cols, message.rows);
            }
            terminal.write(message.data, () => {
              unparsed -= message.data.length;
              if (disposed || current !== socket) return;
              if (current.readyState === WebSocket.OPEN && message.data.length)
                current.send(
                  JSON.stringify({ type: 'ack', bytes: message.data.length }),
                );
              if (message.type === 'snapshot') {
                ready = message.status === 'running';

                setStatus(ready ? 'Connected' : 'Shell exited');
                resize();
                terminal?.focus();
              }
            });
          } else if (message.type === 'resize')
            terminal.resize(message.cols, message.rows);
          else if (message.type === 'exit') {
            ready = false;
            setStatus('Shell exited');
            exitCallback.current();
          }
        };
        current.onclose = (event) => {
          if (disposed || current !== socket) return;
          const message = terminalCloseMessage(event.code);
          if (message) {
            ready = false;
            setStatus(message);
            return;
          }
          ready = false;
          setStatus('Reconnecting…');
          reconnect = setTimeout(
            () => void connect(),
            Math.min(10000, 800 * 2 ** attempt++),
          );
        };
        current.onerror = () => current.close();
      } catch (error) {
        if (disposed) return;
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          (error.status === 401 || error.status === 403)
        ) {
          setStatus('Sign in to the workspace again to reconnect.');
          return;
        }
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          error.status === 404
        ) {
          setStatus('Session ended. Create a new terminal.');
          exitCallback.current();
          return;
        }
        setStatus('Connection unavailable. Retrying…');
        reconnect = setTimeout(() => void connect(), 5000);
      }
    }
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !element.current) return;
      terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        scrollback: 5000,
        theme: {
          background: '#101012',
          foreground: '#d5d5dc',
          cursor: '#c5d3c9',
          selectionBackground: '#ffffff24',
        },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element.current);
      terminal.onData((data) => {
        if (!ready) return;
        for (let i = 0; i < data.length; i += 8192)
          send({ type: 'input', data: data.slice(i, i + 8192) });
      });
      observer = new ResizeObserver(resize);
      observer.observe(element.current);
      await connect();
    })().catch(() => {
      if (!disposed)
        setStatus('Terminal could not load. Close and reopen to retry.');
    });
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      observer?.disconnect();
      socket?.close();
      terminal?.dispose();
    };
  }, [api, id]);
  return (
    <>
      <div className="terminal-connection">
        <i className={status === 'Connected' ? 'connected' : ''} />
        {status}
      </div>
      <div className="terminal-surface" ref={element} />
    </>
  );
}
export function TerminalPanel({
  api,
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  api: WebcodeApi;
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState('');
  const requestId = useRef<string | undefined>(undefined);
  const listVersion = useRef(0);
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    const version = ++listVersion.current;
    void api
      .terminals(projectId)
      .then((items) => {
        if (cancelled || version !== listVersion.current) return;
        setSessions(items);
        setError('');
        setConfirmEnd('');
        let saved = '';
        try {
          saved = localStorage.getItem(`webcode.terminal.${projectId}`) ?? '';
        } catch {
          /* Storage optional. */
        }
        setSelected(
          items.find((s) => s.id === saved)?.id ?? items[0]?.id ?? '',
        );
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, open]);
  function select(id: string) {
    setSelected(id);
    setConfirmEnd('');
    try {
      localStorage.setItem(`webcode.terminal.${projectId}`, id);
    } catch {
      /* Storage optional. */
    }
  }
  async function create() {
    if (busy) return;
    setBusy(true);
    setError('');
    requestId.current ??= crypto.randomUUID();
    try {
      const session = await api.createTerminal(projectId, requestId.current);
      requestId.current = undefined;
      setSessions((items) => [
        ...items.filter((s) => s.id !== session.id),
        session,
      ]);
      select(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create terminal.');
    } finally {
      setBusy(false);
    }
  }
  async function end() {
    setBusy(true);
    setError('');
    try {
      await api.endTerminal(confirmEnd);
      const next = sessions.filter((s) => s.id !== confirmEnd);
      setSessions(next);
      if (selected === confirmEnd) select(next[0]?.id ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end terminal.');
    } finally {
      setBusy(false);
      setConfirmEnd('');
    }
  }
  return (
    <section
      className={`terminal-panel terminal-dock${open ? ' is-open' : ''}`}
      aria-label="Project terminals"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="terminal-header">
        <TerminalSquare size={17} />
        <div>
          <h2>
            Terminal <span>{projectName}</span>
          </h2>
          <p>Closing this panel keeps your sessions running.</p>
        </div>
        <button
          type="button"
          className="terminal-hide"
          aria-label="Hide terminal panel"
          title="Hide panel — sessions keep running"
          onClick={() => onOpenChange(false)}
        >
          <ChevronDown size={17} />
        </button>
      </header>
      <div className="terminal-tabs">
        {sessions.map((s) => (
          <div
            className={`terminal-tab${s.id === selected ? ' selected' : ''}`}
            key={s.id}
          >
            <button
              type="button"
              aria-pressed={s.id === selected}
              onClick={() => select(s.id)}
            >
              {s.name}
              {s.status === 'exited' && <small>Exited</small>}
            </button>
            <button
              type="button"
              className="terminal-tab-close"
              aria-label={`Close ${s.name}`}
              title="End terminal session"
              disabled={busy}
              onClick={() => setConfirmEnd(s.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New terminal"
          disabled={busy || !projectId || sessions.length >= 4}
          onClick={() => void create()}
        >
          <Plus size={16} />
        </button>
      </div>
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      {open && selected ? (
        <TerminalView
          key={selected}
          api={api}
          id={selected}
          onExit={() => {
            setSessions((items) =>
              items.map((s) =>
                s.id === selected ? { ...s, status: 'exited' } : s,
              ),
            );
          }}
        />
      ) : (
        <div className="terminal-empty">
          <TerminalSquare size={26} />
          <h3>A shell that stays with you.</h3>
          <p>
            Run commands in {projectName}. Reopen this panel to pick up where
            you left off.
          </p>
          <button
            type="button"
            disabled={busy || !projectId}
            onClick={() => void create()}
          >
            {busy ? 'Starting…' : 'New terminal'}
          </button>
        </div>
      )}
      <footer className="terminal-footer">
        <span>Server shell · Sessions last until ended or server restart</span>
      </footer>
      {confirmEnd && (
        <div className="terminal-end-confirm">
          <p>
            End{' '}
            {sessions.find((s) => s.id === confirmEnd)?.name ?? 'this terminal'}{' '}
            and stop its running commands?
          </p>
          <button type="button" onClick={() => setConfirmEnd('')}>
            Keep running
          </button>
          <button type="button" disabled={busy} onClick={() => void end()}>
            End session
          </button>
        </div>
      )}
    </section>
  );
}
