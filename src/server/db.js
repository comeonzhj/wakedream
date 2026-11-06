// SQLite 数据层（node:sqlite，零外部依赖）。归属：lead 冻结 schema；各 worker 只用自己的表。
// 约定：表结构变更只允许追加迁移函数，不得就地改列语义。
import { DatabaseSync } from 'node:sqlite';
import { ensureHome, paths } from '../shared/config.js';

const MIGRATIONS = [
  {
    id: 1,
    name: 'init',
    sql: `
      create table if not exists meta(key text primary key, value text);

      -- 会话：所有来源（本机各 agent + 远端设备同步来的）统一进这张表
      create table if not exists sessions(
        id text primary key,              -- 全局 id：<host>:<agent>:<native_id>
        native_id text not null,
        agent text not null,              -- claude-code / codex / dsh / cursor ...
        host text not null default 'local',
        project text,
        project_path text,
        title text,
        cwd text,
        model text,
        started_at integer,               -- epoch ms
        ended_at integer,
        message_count integer default 0,
        tokens integer,
        file_path text,                   -- 本机为真实路径；远端为缓存镜像路径
        file_mtime integer,
        file_size integer,
        is_subagent integer default 0,
        parent_id text,
        source text,                      -- local | ssh:<remoteId> | lan:<remoteId>
        extra text,                       -- JSON
        deleted integer default 0,
        updated_at integer
      );
      create index if not exists idx_sessions_started on sessions(started_at desc);
      create index if not exists idx_sessions_agent on sessions(agent, started_at desc);
      create index if not exists idx_sessions_host on sessions(host, started_at desc);
      create index if not exists idx_sessions_parent on sessions(parent_id);

      create table if not exists messages(
        session_id text not null,
        seq integer not null,
        role text,                        -- user | assistant | system | tool
        kind text,                        -- text | thinking | tool_call | tool_result | meta
        ts integer,
        text text,
        meta text,                        -- JSON
        primary key(session_id, seq)
      );
      create index if not exists idx_messages_session on messages(session_id, seq);

      -- 远端设备（SSH 主机或局域网对端）
      create table if not exists remotes(
        id text primary key,
        kind text not null,               -- ssh | lan
        name text,
        host text, user text, port integer,
        root text,                        -- ssh: 远端家目录/白名单根
        url text,                         -- lan: http://192.168.x.x:4680
        token text,                       -- lan: 对端配对 token
        enabled integer default 1,
        last_sync integer, last_status text, last_error text,
        extra text,
        created_at integer
      );

      -- 夜间做梦的一次运行
      create table if not exists dreams(
        id text primary key,
        day text not null,                -- YYYY-MM-DD（被整理的当天）
        store text default 'default',
        status text not null,             -- running | ok | failed | dry-run
        provider text, model text,
        session_count integer default 0,
        started_at integer, finished_at integer,
        memory_dir text, report_path text,
        stats text, error text
      );
      create index if not exists idx_dreams_day on dreams(day desc, started_at desc);

      create table if not exists dream_inputs(
        dream_id text not null, session_id text not null,
        chars integer, notes text,
        primary key(dream_id, session_id)
      );

      -- 做梦产出的记忆文件（wiki 式小文件，落盘在 memory/dreams/<day>/<store>/）
      create table if not exists memory_files(
        dream_id text not null, path text not null,
        title text, kind text,            -- index | project | session | decision | preference | open-question
        source_sessions text,             -- JSON 数组
        bytes integer, updated_at integer,
        primary key(dream_id, path)
      );
      create index if not exists idx_memory_files_path on memory_files(path);
    `,
  },
];

let db = null;

export function getDb() {
  if (db) return db;
  ensureHome();
  db = new DatabaseSync(paths.db);
  db.exec('pragma journal_mode = wal');
  db.exec('pragma busy_timeout = 5000');
  runMigrations(db);
  return db;
}

function runMigrations(handle) {
  handle.exec('create table if not exists schema_migrations(id integer primary key, name text, applied_at integer)');
  const applied = new Set(handle.prepare('select id from schema_migrations').all().map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    handle.exec('begin');
    try {
      handle.exec(m.sql);
      handle.prepare('insert into schema_migrations(id,name,applied_at) values (?,?,?)').run(m.id, m.name, Date.now());
      handle.exec('commit');
    } catch (err) {
      handle.exec('rollback');
      throw err;
    }
  }
}

export function closeDb() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}

export function metaGet(key) {
  const row = getDb().prepare('select value from meta where key = ?').get(key);
  return row?.value ?? null;
}

export function metaSet(key, value) {
  getDb()
    .prepare('insert into meta(key,value) values (?,?) on conflict(key) do update set value = excluded.value')
    .run(key, String(value));
}

export function nowTs() {
  return Date.now();
}

// session 行 → API JSON（字段名统一成 camelCase，UI 与 CLI 共用）
export function rowToSession(row, { withPreview = false, previewText = null } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    nativeId: row.native_id,
    agent: row.agent,
    host: row.host,
    project: row.project || 'Unknown',
    projectPath: row.project_path || null,
    title: row.title || '',
    cwd: row.cwd || null,
    model: row.model || null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    messageCount: row.message_count ?? 0,
    tokens: row.tokens ?? null,
    filePath: row.file_path || null,
    fileSize: row.file_size ?? null,
    isSubagent: !!row.is_subagent,
    parentId: row.parent_id || null,
    source: row.source || 'local',
    extra: safeJson(row.extra),
  };
  if (withPreview) out.preview = previewText ?? '';
  return out;
}

export function rowToMessage(row) {
  return {
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    ts: row.ts,
    text: row.text ?? '',
    meta: safeJson(row.meta),
  };
}

export function rowToRemote(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    host: row.host,
    user: row.user,
    port: row.port,
    root: row.root,
    url: row.url,
    token: row.token,
    enabled: !!row.enabled,
    lastSync: row.last_sync ?? null,
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    extra: safeJson(row.extra),
  };
}

export function rowToDream(row) {
  if (!row) return null;
  return {
    id: row.id,
    day: row.day,
    store: row.store,
    status: row.status,
    provider: row.provider,
    model: row.model,
    sessionCount: row.session_count ?? 0,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    memoryDir: row.memory_dir ?? null,
    reportPath: row.report_path ?? null,
    stats: safeJson(row.stats),
    error: row.error ?? null,
  };
}

export function safeJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return fallback; }
}
