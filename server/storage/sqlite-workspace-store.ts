import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  TurnExecution,
  Orchestration,
  ApprovalDecision,
  ApprovalRequest,
  Project,
  Task,
  TaskDetail,
  TaskEvent,
  TaskStatus,
  Turn,
  TurnStatus,
} from '../../lib/workspace/contracts.ts';
import type {
  AppendEventInput,
  CreateApprovalInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTurnInput,
  WorkspaceStore,
} from './workspace-store.ts';

const migrations = [
  `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      is_git_repository INTEGER NOT NULL CHECK (is_git_repository IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      provider_thread_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX tasks_project_updated_idx ON tasks(project_id, updated_at DESC);

    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      provider_turn_id TEXT,
      client_request_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(task_id, client_request_id)
    );
    CREATE INDEX turns_task_created_idx ON turns(task_id, created_at);

    CREATE TABLE task_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX task_events_task_sequence_idx ON task_events(task_id, sequence);

    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      provider_request_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(task_id, provider_request_id)
    );
    CREATE INDEX approvals_task_status_idx ON approvals(task_id, status, created_at);
  `,
  `
    CREATE TABLE approvals_v2 (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      provider_request_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(turn_id, provider_request_id)
    );
    INSERT INTO approvals_v2 SELECT * FROM approvals;
    DROP TABLE approvals;
    ALTER TABLE approvals_v2 RENAME TO approvals;
    CREATE INDEX approvals_task_status_idx ON approvals(task_id, status, created_at);
    ALTER TABLE turns ADD COLUMN model TEXT;
    ALTER TABLE turns ADD COLUMN reasoning_effort TEXT;
    ALTER TABLE turns ADD COLUMN request_json TEXT;
  `,
  `ALTER TABLE turns ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'workspace' CHECK(permission_mode IN ('read-only', 'workspace', 'full-access'));`,
  `ALTER TABLE turns ADD COLUMN orchestration_json TEXT;
    CREATE TABLE turn_executions (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK(phase IN ('plan', 'work', 'review')),
      payload_json TEXT NOT NULL,
      UNIQUE(turn_id, phase)
    );
    CREATE TABLE approvals_v4 (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      provider_request_id INTEGER NOT NULL,
      method TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT NOT NULL,
      status TEXT NOT NULL, decision TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
      execution_id TEXT REFERENCES turn_executions(id)
    );
    INSERT INTO approvals_v4 SELECT *, NULL FROM approvals;
    DROP TABLE approvals;
    ALTER TABLE approvals_v4 RENAME TO approvals;
    CREATE INDEX approvals_task_status_idx ON approvals(task_id, status, created_at);
    CREATE UNIQUE INDEX approvals_legacy_request_idx ON approvals(turn_id, provider_request_id) WHERE execution_id IS NULL;
    CREATE UNIQUE INDEX approvals_execution_request_idx ON approvals(execution_id, provider_request_id) WHERE execution_id IS NOT NULL;
  `,
] as const;

type Row = Record<string, string | number | null>;

export class SqliteWorkspaceStore implements WorkspaceStore {
  readonly #database: Database.Database;

  get attachmentDatabase() {
    return this.#database;
  }

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.#database = new Database(filename);
    this.#database.pragma('foreign_keys = ON');
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('synchronous = NORMAL');
    this.#database.pragma('busy_timeout = 5000');
    this.#migrate();
  }

  transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation)();
  }

  listProjects(): readonly Project[] {
    return (
      this.#database
        .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
        .all() as Row[]
    ).map(projectFromRow);
  }

  getProject(id: string): Project | undefined {
    const row = this.#database
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  findProjectByPath(path: string): Project | undefined {
    const row = this.#database
      .prepare('SELECT * FROM projects WHERE root_path = ?')
      .get(path) as Row | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  createProject(input: CreateProjectInput): Project {
    this.#database
      .prepare(`
      INSERT INTO projects (id, name, root_path, is_git_repository, created_at, updated_at)
      VALUES (@id, @name, @path, @isGitRepository, @now, @now)
    `)
      .run({ ...input, isGitRepository: input.isGitRepository ? 1 : 0 });
    return this.getProject(input.id)!;
  }

  listTasks(projectId?: string, includeArchived = false): readonly Task[] {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (projectId) {
      conditions.push('project_id = ?');
      parameters.push(projectId);
    }
    if (!includeArchived) conditions.push('archived_at IS NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return (
      this.#database
        .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`)
        .all(...parameters) as Row[]
    ).map(taskFromRow);
  }

  setTaskArchived(id: string, archivedAt: string | null): void {
    this.#database
      .prepare('UPDATE tasks SET archived_at = ? WHERE id = ?')
      .run(archivedAt, id);
  }

  getTask(id: string): Task | undefined {
    const row = this.#database
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  getTaskDetail(id: string, afterSequence = 0): TaskDetail | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;
    const project = this.getProject(task.projectId);
    if (!project) return undefined;
    const turns = (
      this.#database
        .prepare('SELECT * FROM turns WHERE task_id = ? ORDER BY created_at')
        .all(id) as Row[]
    ).map(turnFromRow);
    const approvals = (
      this.#database
        .prepare(
          'SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at',
        )
        .all(id) as Row[]
    ).map(approvalFromRow);
    const events = this.listEvents(id, afterSequence);
    const nextSequence = events.at(-1)?.sequence ?? afterSequence;
    return {
      task,
      project,
      nextSequence,
      hasMore: this.listEvents(id, nextSequence, 1).length > 0,
      turns: turns.map((turn) =>
        turn.orchestration
          ? { ...turn, executions: this.listExecutions(turn.id) }
          : turn,
      ),
      events,
      approvals,
    };
  }

  createTask(input: CreateTaskInput): Task {
    this.#database
      .prepare(`
      INSERT INTO tasks (
        id, project_id, provider_id, title, status, model, reasoning_effort, created_at, updated_at
      ) VALUES (@id, @projectId, @providerId, @title, 'idle', @model, @reasoningEffort, @now, @now)
    `)
      .run({
        ...input,
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
      });
    return this.getTask(input.id)!;
  }

  updateTaskTitle(id: string, title: string, now: string): void {
    this.#database
      .prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now, id);
  }

  setTaskProviderThreadId(
    id: string,
    providerThreadId: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        'UPDATE tasks SET provider_thread_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(providerThreadId, now, id);
  }

  setTaskStatus(id: string, status: TaskStatus, now: string): void {
    this.#database
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
  }

  createTurn(input: CreateTurnInput): { turn: Turn; created: boolean } {
    const existing = this.findTurnByClientRequest(
      input.taskId,
      input.clientRequestId,
    );
    if (existing) return { turn: existing, created: false };
    this.#database
      .prepare(`
      INSERT INTO turns (id, task_id, client_request_id, prompt, status, created_at, model, reasoning_effort, request_json, permission_mode, orchestration_json)
      VALUES (@id, @taskId, @clientRequestId, @prompt, 'queued', @now, @model, @reasoningEffort, @requestJson, @permissionMode, @orchestrationJson)
    `)
      .run({
        ...input,
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        requestJson: input.requestJson ?? null,
        permissionMode: input.permissionMode ?? 'workspace',
        orchestrationJson: input.orchestration
          ? JSON.stringify(input.orchestration)
          : null,
      });
    return { turn: this.getTurn(input.id)!, created: true };
  }

  findTurnByClientRequest(
    taskId: string,
    clientRequestId: string,
  ): Turn | undefined {
    const row = this.#database
      .prepare(
        'SELECT * FROM turns WHERE task_id = ? AND client_request_id = ?',
      )
      .get(taskId, clientRequestId) as Row | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  getTurn(id: string): Turn | undefined {
    const row = this.#database
      .prepare('SELECT * FROM turns WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  setTurnStatus(
    id: string,
    status: TurnStatus,
    now: string,
    options: { providerTurnId?: string; error?: string } = {},
  ): void {
    const completedAt = ['completed', 'failed', 'interrupted'].includes(status)
      ? now
      : null;
    this.#database
      .prepare(`
      UPDATE turns
      SET status = ?, provider_turn_id = COALESCE(?, provider_turn_id), error = ?, completed_at = ?
      WHERE id = ?
    `)
      .run(
        status,
        options.providerTurnId ?? null,
        options.error ?? null,
        completedAt,
        id,
      );
  }

  createExecution(execution: TurnExecution): void {
    this.#database
      .prepare(
        'INSERT INTO turn_executions (id, turn_id, phase, payload_json) VALUES (?, ?, ?, ?)',
      )
      .run(
        execution.id,
        execution.turnId,
        execution.phase,
        JSON.stringify(execution),
      );
  }

  updateExecution(
    id: string,
    update: Partial<
      Pick<
        TurnExecution,
        | 'status'
        | 'providerThreadId'
        | 'providerTurnId'
        | 'result'
        | 'error'
        | 'completedAt'
      >
    >,
  ): void {
    const row = this.#database
      .prepare('SELECT payload_json FROM turn_executions WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new Error('Execution not found');
    this.#database
      .prepare('UPDATE turn_executions SET payload_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...parseJsonObject(row.payload_json), ...update }),
        id,
      );
  }

  listExecutions(turnId: string): readonly TurnExecution[] {
    return (
      this.#database
        .prepare(
          "SELECT payload_json FROM turn_executions WHERE turn_id = ? ORDER BY CASE phase WHEN 'plan' THEN 0 WHEN 'work' THEN 1 ELSE 2 END",
        )
        .all(turnId) as Row[]
    ).map((row) => JSON.parse(String(row.payload_json)) as TurnExecution);
  }

  appendEvent(input: AppendEventInput): TaskEvent {
    const result = this.#database
      .prepare(`
      INSERT INTO task_events (task_id, turn_id, event_type, payload_json, created_at)
      VALUES (@taskId, @turnId, @type, @payload, @now)
    `)
      .run({
        ...input,
        turnId: input.turnId ?? null,
        payload: JSON.stringify(input.data),
      });
    const row = this.#database
      .prepare('SELECT * FROM task_events WHERE sequence = ?')
      .get(result.lastInsertRowid) as Row;
    return eventFromRow(row);
  }

  listEvents(
    taskId: string,
    afterSequence = 0,
    limit = 5_000,
  ): readonly TaskEvent[] {
    return (
      this.#database
        .prepare(`
        SELECT * FROM task_events
        WHERE task_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?
      `)
        .all(
          taskId,
          afterSequence,
          Math.min(Math.max(limit, 1), 5_000),
        ) as Row[]
    ).map(eventFromRow);
  }

  createApproval(input: CreateApprovalInput): ApprovalRequest {
    this.#database
      .prepare(`
      INSERT INTO approvals (
        id, task_id, turn_id, provider_request_id, method, summary, details_json, status, created_at, execution_id
      ) VALUES (@id, @taskId, @turnId, @providerRequestId, @method, @summary, @details, 'pending', @now, @executionId)
    `)
      .run({
        ...input,
        executionId: input.executionId ?? null,
        details: JSON.stringify(input.details),
      });
    return this.getApproval(input.id)!;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    const row = this.#database
      .prepare('SELECT * FROM approvals WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? approvalFromRow(row) : undefined;
  }

  resolveApproval(
    id: string,
    decision: ApprovalDecision,
    now: string,
  ): ApprovalRequest | undefined {
    this.#database
      .prepare(`
      UPDATE approvals SET status = 'resolved', decision = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `)
      .run(decision, now, id);
    return this.getApproval(id);
  }

  recoverIncompleteWork(now: string): void {
    const recover = this.#database.transaction(() => {
      const turns = this.#database
        .prepare(
          "SELECT id, task_id FROM turns WHERE status IN ('queued', 'running')",
        )
        .all() as Array<{ id: string; task_id: string }>;
      this.#database
        .prepare(`
        UPDATE turns
        SET status = 'failed', error = 'Server restarted before the turn completed', completed_at = ?
        WHERE status IN ('queued', 'running')
      `)
        .run(now);
      this.#database
        .prepare(
          "UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'running'",
        )
        .run(now);
      this.#database
        .prepare(`
        UPDATE approvals
        SET status = 'resolved', decision = 'cancel', resolved_at = ?
        WHERE status = 'pending'
      `)
        .run(now);
      const append = this.#database.prepare(`
        INSERT INTO task_events (task_id, turn_id, event_type, payload_json, created_at)
        VALUES (?, ?, 'turn.status', ?, ?)
      `);
      for (const turn of turns) {
        for (const execution of this.listExecutions(turn.id)) {
          if (execution.status !== 'running' && execution.status !== 'queued')
            continue;
          this.updateExecution(execution.id, {
            status: 'failed',
            error: 'Server restarted before the execution completed',
            completedAt: now,
          });
          this.appendEvent({
            taskId: turn.task_id,
            turnId: turn.id,
            type: 'execution.status',
            data: {
              executionId: execution.id,
              phase: execution.phase,
              providerId: execution.providerId,
              status: 'failed',
            },
            now,
          });
        }
        append.run(
          turn.task_id,
          turn.id,
          JSON.stringify({
            status: 'failed',
            error: 'Server restarted before the turn completed',
          }),
          now,
        );
      }
    });
    recover();
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      this.#database
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number((row as Row).version)),
    );
    const apply = this.#database.transaction((version: number, sql: string) => {
      this.#database.exec(sql);
      this.#database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(version, new Date().toISOString());
    });
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (!applied.has(version)) apply(version, sql);
    });
  }
}

function projectFromRow(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.root_path),
    isGitRepository: row.is_git_repository === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function taskFromRow(row: Row): Task {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    providerId: String(row.provider_id),
    ...(row.provider_thread_id
      ? { providerThreadId: String(row.provider_thread_id) }
      : {}),
    title: String(row.title),
    status: row.status as TaskStatus,
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.reasoning_effort
      ? { reasoningEffort: String(row.reasoning_effort) }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.archived_at ? { archivedAt: String(row.archived_at) } : {}),
  };
}

function turnFromRow(row: Row): Turn {
  return {
    ...(row.orchestration_json
      ? {
          orchestration: JSON.parse(
            String(row.orchestration_json),
          ) as Orchestration,
        }
      : {}),
    permissionMode:
      row.permission_mode as import('../../lib/workspace/permissions.ts').PermissionMode,
    id: String(row.id),
    taskId: String(row.task_id),
    ...(row.provider_turn_id
      ? { providerTurnId: String(row.provider_turn_id) }
      : {}),
    clientRequestId: String(row.client_request_id),
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.reasoning_effort
      ? { reasoningEffort: String(row.reasoning_effort) }
      : {}),
    ...(row.request_json ? { requestJson: String(row.request_json) } : {}),
    prompt: String(row.prompt),
    status: row.status as TurnStatus,
    ...(row.error ? { error: String(row.error) } : {}),
    createdAt: String(row.created_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function eventFromRow(row: Row): TaskEvent {
  return {
    sequence: Number(row.sequence),
    taskId: String(row.task_id),
    ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
    type: row.event_type as TaskEvent['type'],
    data: parseJsonObject(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function approvalFromRow(row: Row): ApprovalRequest {
  return {
    ...(row.execution_id ? { executionId: String(row.execution_id) } : {}),
    id: String(row.id),
    taskId: String(row.task_id),
    turnId: String(row.turn_id),
    kind: String(row.method).includes('fileChange') ? 'fileChange' : 'command',
    summary: String(row.summary),
    details: parseJsonObject(row.details_json),
    status: row.status as ApprovalRequest['status'],
    ...(row.decision ? { decision: row.decision as ApprovalDecision } : {}),
    createdAt: String(row.created_at),
    ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
