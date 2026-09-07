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
