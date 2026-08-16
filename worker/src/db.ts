export interface D1Result<T = unknown> {
  results?: T[];
  success?: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<unknown>;
}

export type DbEnv = {
  DB?: D1DatabaseLike;
};

let schemaReady = false;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jarvis_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jarvis_auth_attempts (
  client_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jarvis_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','archived')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jarvis_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('decision','preference','fact','commitment','procedure','note')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 60 CHECK (importance BETWEEN 0 AND 100),
  source TEXT NOT NULL DEFAULT 'explicit',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES jarvis_projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_jarvis_projects_status_priority
  ON jarvis_projects(status, priority DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_jarvis_memories_project
  ON jarvis_memories(project_id, importance DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_jarvis_memories_importance
  ON jarvis_memories(importance DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_jarvis_sessions_expiry
  ON jarvis_sessions(expires_at);
`;

export function dbConfigured(env: DbEnv): boolean {
  return Boolean(env.DB);
}

export async function ensureSchema(env: DbEnv): Promise<D1DatabaseLike> {
  if (!env.DB) throw new Error("DB_NOT_CONFIGURED");
  if (!schemaReady) {
    await env.DB.exec(SCHEMA_SQL);
    schemaReady = true;
  }
  return env.DB;
}
