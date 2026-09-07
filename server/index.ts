import { TerminalService } from './terminal/service.ts';
import { ResourceNotFoundError } from './storage/errors.ts';
import { ProviderInstallations } from './core/provider-installations.ts';
import { CodexInstallation } from './providers/codex/installation.ts';
import { MuseInstallation } from './providers/muse/installation.ts';
import { GrokInstallation } from './providers/grok/installation.ts';
import { ProviderLimitsService } from './core/provider-limits.ts';
import { readCodexLimits } from './providers/codex/limits.ts';
import { AttachmentService } from './attachments/service.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { ProviderRegistry } from './core/provider-registry.ts';
import { CodexDiscovery } from './providers/codex/discovery.ts';
import { MuseDiscovery } from './providers/muse/discovery.ts';
import { GrokDiscovery } from './providers/grok/discovery.ts';
import { InMemoryTicketStore } from './security/websocket-tickets.ts';
import { resolve } from 'node:path';
import { ConnectionHub } from './realtime/connection-hub.ts';
import { SqliteWorkspaceStore } from './storage/sqlite-workspace-store.ts';
import { ProjectService } from './core/project-service.ts';
import { AgentService } from './core/agent-service.ts';
import { CodexTurnRuntime } from './providers/codex/turn-runtime.ts';
import { MuseTurnRuntime } from './providers/muse/turn-runtime.ts';
import { GrokTurnRuntime } from './providers/grok/turn-runtime.ts';

const config = loadConfig();
const providers = new ProviderRegistry(
  [
    new CodexDiscovery({
      binaryPath: config.codex.binaryPath,
      codexHome: config.codex.codexHome,
      cwd: config.workspaceRoot,
      requestTimeoutMs: config.providerProbeTimeoutMs,
    }),
    new MuseDiscovery({
      binaryPath: config.muse.binaryPath,
      museHome: config.muse.museHome,
      cwd: config.workspaceRoot,
      timeoutMs: config.providerProbeTimeoutMs,
    }),
    new GrokDiscovery({
      binaryPath: config.grok.binaryPath,
      grokHome: config.grok.grokHome,
      cwd: config.workspaceRoot,
      requestTimeoutMs: config.providerProbeTimeoutMs,
    }),
  ],
  {
    cacheTtlMs: config.providerCacheTtlMs,
    probeTimeoutMs: config.providerProbeTimeoutMs,
  },
);
const limits = new ProviderLimitsService(
  new Map([
    [
      'codex',
      (signal: AbortSignal) =>
        readCodexLimits(
          {
            binaryPath: config.codex.binaryPath,
            codexHome: config.codex.codexHome,
            cwd: config.workspaceRoot,
            requestTimeoutMs: 5000,
          },
          signal,
        ),
    ],
    [
      'muse',
      async () => ({
        providerId: 'muse',
        status: 'unavailable' as const,
        checkedAt: new Date().toISOString(),
        windows: [],
      }),
    ],
  ]),
);
const tickets = new InMemoryTicketStore({ ttlMs: config.websocketTicketTtlMs });
const hub = new ConnectionHub();
const store = new SqliteWorkspaceStore(
  resolve(config.dataDirectory, 'webcode.sqlite3'),
);
const attachments = new AttachmentService(
  store.attachmentDatabase,
  resolve(config.dataDirectory, 'attachments'),
  config.attachmentLimits,
);
const projects = new ProjectService(store, config.workspaceRoot);
const terminals = new TerminalService((id) => {
  const project = store.getProject(id);
  if (!project) throw new ResourceNotFoundError('Project', id);
  return projects.validatePath(project.path);
});
const installations: ProviderInstallations = new ProviderInstallations(
  new Map([
    [
      'codex',
      { name: 'Codex', driver: new CodexInstallation(config.codex.binaryPath) },
    ],
    [
      'muse',
      { name: 'Muse', driver: new MuseInstallation(config.muse.binaryPath) },
    ],
    [
      'grok',
      { name: 'Grok', driver: new GrokInstallation(config.grok.binaryPath) },
    ],
  ]),
  providers,
  () => agents.isBusy,
);
const agents: AgentService = new AgentService(
  store,
  hub,
  [
    new CodexTurnRuntime({
      binaryPath: config.codex.binaryPath,
      codexHome: config.codex.codexHome,
      requestTimeoutMs: config.providerProbeTimeoutMs,
    }),
    new MuseTurnRuntime({
      binaryPath: config.muse.binaryPath,
      museHome: config.muse.museHome,
      timeoutMs: config.providerProbeTimeoutMs,
    }),
    new GrokTurnRuntime({
      binaryPath: config.grok.binaryPath,
      grokHome: config.grok.grokHome,
      requestTimeoutMs: config.providerProbeTimeoutMs,
    }),
  ],
  {
    attachments,
    maintenance: installations.isUpdating,
    validatePath: (path) => projects.validatePath(path),
    onError: (error): void => {
      app.log.error({ err: error }, 'Provider execution failed');
    },
  },
);
const app = await buildApp({
  terminals,
  installations,
  limits,
  attachments,
  config,
  providers,
  tickets,
  hub,
  projects,
  agents,
  store,
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  const forcedExit = setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forcedExit.unref();
  await app.close();
  clearTimeout(forcedExit);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  process.exitCode = 1;
}
