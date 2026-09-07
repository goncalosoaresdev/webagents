# Reconnectable project terminals

The browser is a view of a server-owned PTY, not the owner of the shell. Refreshing, switching projects, closing the panel, or closing a browser tab detaches the view. The shell continues running, retaining its working directory, variables, jobs, and terminal state. Opening the panel lists the project's sessions; local storage remembers the selected session and open panel. Credentials, terminal output, and input are not persisted in browser storage.

## Research and choice

- [node-pty](https://github.com/microsoft/node-pty) provides an actual pseudo-terminal, supporting interactive shells, ANSI programs, resize, and terminal signals, unlike ordinary child-process pipes.
- [xterm.js serialization](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize) restores the terminal framebuffer, cursor, modes, and bounded scrollback. A server-side headless emulator keeps parsing while no browser is connected. Snapshot delivery and live subscriptions share its parser queue to avoid a gap between replay and live output. Serialization is an experimental upstream addon; full-screen applications and unusual escape sequences should receive compatibility testing before relying on them for critical work.
- [xterm.js flow control](https://xtermjs.org/docs/guides/flowcontrol/) recommends PTY pause/resume watermarks and write-completion acknowledgements. Both are applied here; slow browser connections reconnect to a fresh snapshot rather than stalling a detached shell.
- [tmux](https://github.com/tmux/tmux/wiki) can keep shells running independently of the Webcode server. It was considered, but is not installed or required by this implementation. A tmux-backed driver or separate terminal daemon is the next step for surviving server deploys/restarts.
- [xterm.js security guidance](https://xtermjs.org/docs/guides/security/) informs authenticated transport, controlled dependencies, and avoiding raw HTML or automatic clipboard/link integration.

## Persistence boundary

Sessions survive browser refreshes, tab closure, network disconnections, and reconnecting from another device while the **same Webcode Node server remains running**. They do not survive a Webcode server restart, development hot reload, container replacement, or VPS reboot. No commands are replayed to imitate process restoration. Missing sessions are reported as ended and a new terminal requires explicit creation. The frontend labels this boundary in the panel footer.

The API is provider-independent and project-scoped. Multiple tasks in a project share the same terminal list. Sessions remain available after the shell exits until explicitly removed. A terminal runs as Webcode's server OS user and has that user's permissions; it is independent of Codex's approval/sandbox settings. Registered project paths are validated at creation. The spawned environment excludes Webcode bearer tokens and other server secrets, using a small shell-environment allowlist. Users can still access files allowed to that OS account; this is a single-owner workspace, not a multi-tenant sandbox.

## Transport and limits

Authenticated HTTP creates/lists/ends sessions and mints 30-second single-use terminal-specific WebSocket tickets. The dedicated `/terminal-ws` endpoint requires an allowlisted browser Origin and the scoped ticket. The existing request serializer excludes query strings from logs. Connection closure only unsubscribes; explicit End session terminates the shell. Creating a session uses a client UUID for retry idempotency.

Limits: 12 sessions per server, 4 per project, 4 viewers per terminal, 5,000 lines of retained scrollback, 20–300 columns and 5–100 rows. PTY processing uses high/low watermarks; browser acknowledgements bound live output, and input frames and rates are limited. Multiple viewers share a terminal size; the most recent resize takes effect. Scrollback is bounded and is not an audit log. The application makes no guarantee that detached child daemons which ignore terminal hangup will exit with their parent shell.

## Deployment

Install dependencies with `npm ci`. Linux may require the native build tools documented by node-pty if a compatible prebuild is unavailable. A project postinstall script restores the executable bit on node-pty's macOS spawn helper when its package is unpacked without it. Proxy `/terminal-ws` as a WebSocket to the Node server alongside `/ws`; Vite development proxy already includes it. Use TLS and run Webcode as a non-root account. A graceful shutdown intentionally ends the in-process terminals.

Unit and in-memory API/WebSocket tests cover detach/reconnect, retained output, shell variables in a real PTY, creation idempotency, session limits, scoped tickets, and origin/authentication checks. Browser tests are left to the project owner as requested.
