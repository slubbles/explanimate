/**
 * The sign-in database lives in Cloudflare D1, reached over its REST API: the app runs in Docker
 * on a normal server, not in a Worker, so there is no D1 binding to use. App code talks to a small
 * D1-shaped interface (`prepare(sql).bind(...).first()/all()/run()`); Better Auth gets a Kysely
 * instance whose driver runs every query through the same REST call. D1 REST has no interactive
 * transactions, so begin/commit/rollback are no-ops and Better Auth is told not to use them.
 *
 * Failures log Cloudflare's error codes and the statement shape, never the token or values.
 */
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type DatabaseMetadataOptions,
  type TableMetadata,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
} from "kysely";
import path from "node:path";
import { withLegacyDir } from "@explanimate/core/env";
import { createLocalD1Db } from "./db-local";

const D1_TIMEOUT_MS = 10_000;

export interface D1Config {
  accountId: string;
  databaseId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** What one bound statement returns: the first row, all rows, or the write count. */
export interface D1Bound {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<T[]>;
  run(): Promise<{ changes: number; lastRowId: number }>;
}

export interface D1Statement {
  bind(...params: unknown[]): D1Bound;
}

export interface D1Db {
  prepare(sql: string): D1Statement;
}

/** The D1 REST client needs these three; anything missing is a deploy error, thrown when first used. */
export function d1ConfigFromEnv(fetchImpl: typeof fetch = fetch): D1Config {
  const accountId = process.env.EXPLANIMATE_CF_ACCOUNT_ID;
  const databaseId = process.env.EXPLANIMATE_D1_DATABASE_ID;
  const token = process.env.EXPLANIMATE_D1_TOKEN;
  if (!accountId || !databaseId || !token)
    throw new Error("EXPLANIMATE_CF_ACCOUNT_ID, EXPLANIMATE_D1_DATABASE_ID and EXPLANIMATE_D1_TOKEN must all be set");
  return { accountId, databaseId, token, fetchImpl };
}

export function createD1Db(config: D1Config): D1Db {
  const run = (sql: string, params: unknown[]) => d1Query(config, sql, params);
  return {
    prepare: (sql: string): D1Statement => ({
      bind: (...params: unknown[]): D1Bound => ({
        first: async <T>() => ((await run(sql, params)).rows[0] as T | undefined) ?? null,
        all: async <T>() => (await run(sql, params)).rows as T[],
        run: async () => {
          const r = await run(sql, params);
          return { changes: r.changes, lastRowId: r.lastRowId };
        },
      }),
    }),
  };
}

/** Where the local SQLite file lives when sign-in is on without D1 in local dev: next to the jobs folder. */
export function defaultLocalD1Path(): string {
  const root = process.env.EXPLANIMATE_ROOT ?? path.resolve(process.cwd(), "../..");
  const jobsDir =
    process.env.EXPLANIMATE_JOBS_DIR ?? withLegacyDir(path.join(root, "explanimate-out", "web"), path.join(root, "explainlike-out", "web"));
  return path.join(jobsDir, "auth.db");
}

/** A local SQLite file standing in for D1 (end-to-end tests, and local dev when sign-in is on without D1); unset in production. */
export function localD1Path(): string | undefined {
  const p = process.env.EXPLANIMATE_D1_LOCAL_PATH?.trim();
  if (p) return p;
  if (
    process.env.EXPLANIMATE_AUTH_ENABLED === "1" &&
    process.env.NODE_ENV !== "production" &&
    !(process.env.EXPLANIMATE_CF_ACCOUNT_ID && process.env.EXPLANIMATE_D1_DATABASE_ID && process.env.EXPLANIMATE_D1_TOKEN)
  )
    return defaultLocalD1Path();
  return undefined;
}

/** The app's D1 handle from the environment (stateless, so no caching or closing). */
export function getD1Db(fetchImpl: typeof fetch = fetch): D1Db {
  const local = localD1Path();
  if (local) return createLocalD1Db(local);
  return createD1Db(d1ConfigFromEnv(fetchImpl));
}

/** True when the three D1 settings are present, or a local stand-in file is set. The error store and admin lists need them. */
export function d1Configured(): boolean {
  if (localD1Path()) return true;
  return !!(process.env.EXPLANIMATE_CF_ACCOUNT_ID && process.env.EXPLANIMATE_D1_DATABASE_ID && process.env.EXPLANIMATE_D1_TOKEN);
}

type D1Value = string | number | null;

/** REST params are JSON: booleans become 0/1, missing values become null. */
function toD1Params(params: readonly unknown[]): D1Value[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "bigint") return Number(p);
    if (typeof p === "string" || typeof p === "number") return p;
    if (p instanceof Date) return p.toISOString();
    return String(p);
  });
}

interface D1Rows {
  rows: Record<string, unknown>[];
  changes: number;
  lastRowId: number;
}

// D1 keeps internal _cf_ tables and refuses (SQLITE_AUTH, code 7500) any query that touches
// one: PRAGMA table_list, a table_info/index_list/index_info/foreign_key_list call on a _cf_
// table, or a schema scan that would read those rows. Better Auth's migration check joins
// sqlite_master to pragma_index_list with no _cf_ filter, which failed every request until
// the guard below. All D1 traffic passes through d1Query, so one rewrite here covers both
// direct statements and the Kysely driver.

/** A PRAGMA table_list answer that skips the sqlite and _cf_ internals. */
function tableListScan(): string {
  return `SELECT 'main' AS schema, name AS name, type AS type, 0 AS ncol, 0 AS wr, 0 AS strict FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' ORDER BY name`;
}

const TABLE_LIST_STMT = /^\s*pragma\s+(?:[A-Za-z_][\w$]*\s*\.\s*)?table_list\s*;?\s*$/i;
const TABLE_LIST_FN = /\bpragma_table_list\b(?:\s*\(\s*\))?/i;
const SCHEMA_SCAN = /\bsqlite_(?:temp_)?(?:master|schema)\b/i;
const CF_GUARD = /_cf_/i;
const FROM_SCHEMA_TABLE = /\bsqlite_(?:temp_)?(?:master|schema)\b\s*(?:as\s+)?(["`']?)([A-Za-z_][\w$]*)\1/i;
const SQL_KEYWORDS = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "natural",
  "on",
  "using",
  "group",
  "order",
  "limit",
  "offset",
  "having",
  "window",
  "union",
  "except",
  "intersect",
  "values",
  "returning",
  "set",
]);

/** Adds the _cf_ exclusion to a schema scan that lacks one (Better Auth's index discovery). */
function injectCfGuard(sql: string): string {
  let qual = "";
  const from = FROM_SCHEMA_TABLE.exec(sql);
  if (from && !SQL_KEYWORDS.has(from[2].toLowerCase())) qual = `${from[1]}${from[2]}${from[1]}.`;
  const pred = `substr(${qual}name, 1, 4) <> '_cf_'`;
  const where = /\bwhere\b/i.exec(sql);
  if (where) {
    const at = where.index + where[0].length;
    return `${sql.slice(0, at)} ${pred} AND${sql.slice(at)}`;
  }
  const tail = /\b(group\s+by|order\s+by|having|limit|offset|window|union|except|intersect)\b|;/i.exec(sql);
  if (tail) return `${sql.slice(0, tail.index)} WHERE ${pred} ${sql.slice(tail.index)}`;
  return `${sql} WHERE ${pred}`;
}

/**
 * Rewrites a statement so D1 never sees its internal tables: PRAGMA table_list becomes a
 * filtered scan, and schema scans without a _cf_ filter gain one. Statements already
 * mentioning _cf_ pass through untouched: a guard of ours, or a direct internal read that
 * D1 must refuse loudly.
 */
function rewriteD1Sql(sql: string): string {
  if (TABLE_LIST_STMT.test(sql)) return tableListScan();
  let out = sql;
  if (TABLE_LIST_FN.test(out)) out = out.replace(TABLE_LIST_FN, `(${tableListScan()})`);
  if (SCHEMA_SCAN.test(out) && !CF_GUARD.test(out)) out = injectCfGuard(out);
  return out;
}

const INFO_PRAGMA_STMT =
  /^\s*pragma\s+(?:[A-Za-z_][\w$]*\s*\.\s*)?(?:table_info|table_xinfo|index_list|index_info|foreign_key_list)\s*\(\s*(.*?)\s*\)\s*;?\s*$/i;
const INFO_PRAGMA_FN =
  /\bpragma_(?:table_info|table_xinfo|index_list|index_info|foreign_key_list)\s*\(\s*(\?|"(?:[^"]|"")*"|'(?:[^']|'')*'|[^\s,)]+)/i;
const CF_PREFIX = /^["'`]?_cf_/i;

/** True when a pragma only asks about an internal table: answer empty without asking D1. */
function isInternalOnlyQuery(sql: string, params: readonly unknown[]): boolean {
  const stmt = INFO_PRAGMA_STMT.exec(sql);
  if (stmt) {
    const arg = stmt[1].trim();
    if (arg === "?") return params.length > 0 && CF_PREFIX.test(String(params[0] ?? ""));
    return CF_PREFIX.test(arg);
  }
  const fn = INFO_PRAGMA_FN.exec(sql);
  if (fn) {
    if (fn[1] === "?") return params.length === 1 && CF_PREFIX.test(String(params[0] ?? ""));
    return CF_PREFIX.test(fn[1]);
  }
  return false;
}

async function d1Query(config: D1Config, sql: string, params: readonly unknown[]): Promise<D1Rows> {
  if (isInternalOnlyQuery(sql, params)) return { rows: [], changes: 0, lastRowId: 0 };
  const statement = rewriteD1Sql(sql);
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const body = JSON.stringify({ sql: statement, params: toD1Params(params) });
  let res: Response | undefined;
  let networkError = "";
  // one retry on a 5xx or a network error; a 4xx is our mistake and is not retried
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(D1_TIMEOUT_MS),
      });
      networkError = "";
      if (res.status < 500 || res.status > 599) break;
      res = undefined;
    } catch (e) {
      networkError = e instanceof Error ? e.message : String(e);
      res = undefined;
    }
  }
  if (!res) throw new Error(`D1 did not answer${networkError ? `: ${networkError}` : ""}`);
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
    result?: { results?: Record<string, unknown>[]; meta?: { changes?: number; last_row_id?: number } }[];
  };
  const first = data.result?.[0];
  if (!res.ok || data.success !== true || !first) {
    const codes = (data.errors ?? [])
      .map((e) => e.code)
      .filter(Boolean)
      .join(",");
    // the statement shape only: values travel as bound params and are never logged
    const snippet = statement.replace(/\s+/g, " ").trim().slice(0, 120);
    const message = `D1 refused the query (http ${res.status}${codes ? `, codes ${codes}` : ""}) sql=${JSON.stringify(snippet)}`;
    console.error(`[db] ${message}`);
    throw new Error(message);
  }
  return {
    rows: first.results ?? [],
    changes: Number(first.meta?.changes) || 0,
    lastRowId: Number(first.meta?.last_row_id) || 0,
  };
}

/**
 * Our own tables: per-day video counts, per-user overrides, which account started which job,
 * and recent server/client errors. Fresh databases get the full videos shape (prompt length,
 * status, cost, plus the finished result: title, format, duration, poster and file names);
 * older ones gain the new columns below, so both old and new rows read the same.
 */
export async function ensureTables(db: D1Db): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT NOT NULL, day TEXT NOT NULL, videos INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day))`,
    )
    .bind()
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS user_limits (
    user_id TEXT PRIMARY KEY, daily_videos INTEGER NOT NULL)`,
    )
    .bind()
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, input TEXT NOT NULL, created_at INTEGER NOT NULL,
    input_len INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'started', cost REAL NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT '', duration_sec REAL NOT NULL DEFAULT 0,
    poster TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '')`,
    )
    .bind()
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, route TEXT NOT NULL, source TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL DEFAULT '')`,
    )
    .bind()
    .run();
  // videos rows from before the result columns: add what is missing. Best effort
  // (a failure is logged, never thrown), because recording a video must never break creating one.
  try {
    const cols = await db.prepare("PRAGMA table_info(videos)").bind().all<{ name: string }>();
    const have = new Set(cols.map((c) => c.name));
    for (const [column, ddl] of [
      ["input_len", "ALTER TABLE videos ADD COLUMN input_len INTEGER NOT NULL DEFAULT 0"],
      ["status", "ALTER TABLE videos ADD COLUMN status TEXT NOT NULL DEFAULT 'started'"],
      ["cost", "ALTER TABLE videos ADD COLUMN cost REAL NOT NULL DEFAULT 0"],
      ["title", "ALTER TABLE videos ADD COLUMN title TEXT NOT NULL DEFAULT ''"],
      ["format", "ALTER TABLE videos ADD COLUMN format TEXT NOT NULL DEFAULT ''"],
      ["duration_sec", "ALTER TABLE videos ADD COLUMN duration_sec REAL NOT NULL DEFAULT 0"],
      ["poster", "ALTER TABLE videos ADD COLUMN poster TEXT NOT NULL DEFAULT ''"],
      ["files", "ALTER TABLE videos ADD COLUMN files TEXT NOT NULL DEFAULT ''"],
    ] as const) {
      if (!have.has(column)) await db.prepare(ddl).bind().run();
    }
  } catch (e) {
    console.error(`[db] videos migration skipped: ${(e as Error).message}`);
  }
}

/**
 * Every table ensureTables owns and the columns each must end up with. The sign-in fast path
 * checks these (plus Better Auth's own tables) with one query before skipping migrations;
 * change this whenever ensureTables changes what it creates.
 */
export const APP_TABLE_COLUMNS: Record<string, readonly string[]> = {
  usage: ["user_id", "day", "videos"],
  user_limits: ["user_id", "daily_videos"],
  videos: ["id", "user_id", "input", "created_at", "input_len", "status", "cost", "title", "format", "duration_sec", "poster", "files"],
  errors: ["id", "ts", "route", "source", "name", "message", "stack", "request_id"],
};

/** Better Auth's tables: sign-in, sessions and accounts, plus email-code verification. */
const AUTH_TABLES = ["user", "session", "account", "verification"] as const;

/** True when every sign-in table is present, so a migration failure must not block sessions. */
export async function authTablesExist(db: D1Db): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND substr(name, 1, 4) <> '_cf_' AND name IN ('user', 'session', 'account', 'verification')`,
    )
    .bind()
    .all<{ name: string }>();
  const have = new Set(rows.map((r) => r.name));
  return AUTH_TABLES.every((t) => have.has(t));
}

// ---- the Kysely dialect Better Auth runs on ----

class D1RestConnection implements DatabaseConnection {
  private config: D1Config;
  constructor(config: D1Config) {
    this.config = config;
  }
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const r = await d1Query(this.config, compiled.sql, compiled.parameters);
    return {
      rows: (r.rows ?? []) as R[],
      numAffectedRows: BigInt(r.changes),
      insertId: r.lastRowId ? BigInt(r.lastRowId) : undefined,
    };
  }
  // D1 REST has no streaming; like Better Auth's own D1 driver, say so loudly.
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming queries.");
  }
}

class D1RestDriver implements Driver {
  private config: D1Config;
  constructor(config: D1Config) {
    this.config = config;
  }
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1RestConnection(this.config);
  }
  // D1 REST has no interactive transactions; Better Auth is configured not to use them.
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class D1RestAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true;
  }
}

export class D1RestDialect implements Dialect {
  private config: D1Config;
  constructor(config: D1Config) {
    this.config = config;
  }
  createDriver(): Driver {
    return new D1RestDriver(this.config);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createAdapter(): DialectAdapter {
    return new D1RestAdapter();
  }
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new D1RestIntrospector(db);
  }
}

/**
 * Kysely's SQLite introspector reads pragma_table_info for every table, and D1 refuses that
 * (SQLITE_AUTH, code 7500) for its internal `_cf_*` tables, which broke Better Auth's
 * migrations. This one skips those tables and reads the rest the same way.
 */
class D1RestIntrospector implements DatabaseIntrospector {
  private db: Kysely<any>;
  private base: SqliteIntrospector;
  constructor(db: Kysely<any>) {
    this.db = db;
    this.base = new SqliteIntrospector(db);
  }
  getSchemas() {
    return this.base.getSchemas();
  }
  getMetadata(options?: DatabaseMetadataOptions) {
    return this.getTables(options).then((tables) => ({ tables }));
  }
  async getTables(_options?: DatabaseMetadataOptions): Promise<TableMetadata[]> {
    const tables = await sql<{ name: string; type: string; sql: string | null }>`
      SELECT name, type, sql FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_'
      ORDER BY name`.execute(this.db);
    const out: TableMetadata[] = [];
    for (const t of tables.rows) {
      const cols = await sql<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>`
        SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${t.name})`.execute(this.db);
      const auto = /autoincrement/i.test(t.sql ?? "");
      out.push({
        name: t.name,
        isView: t.type === "view",
        isForeign: false,
        columns: cols.rows.map((c) => ({
          name: c.name,
          dataType: c.type,
          isNullable: !c.notnull,
          isAutoIncrementing: auto && c.pk > 0,
          hasDefaultValue: c.dflt_value != null,
          comment: undefined,
        })),
      });
    }
    return out;
  }
}

/** A Kysely instance over D1 REST (Better Auth takes this with `transaction: false`). */
export function createKysely(config: D1Config): Kysely<any> {
  return new Kysely({ dialect: new D1RestDialect(config) });
}
