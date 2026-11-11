/**
 * A local SQLite stand-in for the D1 sign-in database, for end-to-end tests. When
 * EXPLANIMATE_D1_LOCAL_PATH points at a file, the app uses it instead of D1 REST:
 * the same D1-shaped interface over node:sqlite, and a Kysely dialect over the same
 * file for Better Auth. One cached connection per path per process. node:sqlite loads
 * only when the stand-in is used, so production on older Node keeps working.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
} from "kysely";
import type { D1Bound, D1Db } from "./db";

type SqliteValue = null | number | bigint | string | Buffer;

const g = globalThis as unknown as { __explanimateLocalDbs?: Map<string, DatabaseSync> };
const dbs = (): Map<string, DatabaseSync> => (g.__explanimateLocalDbs ??= new Map());

function loadSqlite(): typeof import("node:sqlite") {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  try {
    if (typeof getBuiltin !== "function") throw new Error("no getBuiltinModule");
    return getBuiltin.call(process, "node:sqlite") as typeof import("node:sqlite");
  } catch {
    throw new Error("EXPLANIMATE_D1_LOCAL_PATH needs Node 22.5 or newer (node:sqlite).");
  }
}

function openDb(file: string): DatabaseSync {
  const hit = dbs().get(file);
  if (hit) return hit;
  const sqlite = loadSqlite();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  dbs().set(file, db);
  return db;
}

/** REST params are JSON: booleans become 0/1, missing values become null. */
function toParams(params: readonly unknown[]): SqliteValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "bigint" || typeof p === "number" || typeof p === "string") return p;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(p)) return p;
    if (p instanceof Date) return p.toISOString();
    return String(p);
  });
}

/** A D1-shaped handle over a local SQLite file (default: EXPLANIMATE_D1_LOCAL_PATH). */
export function createLocalD1Db(file = process.env.EXPLANIMATE_D1_LOCAL_PATH ?? ":memory:"): D1Db {
  const db = openDb(file);
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]): D1Bound => {
        const args = toParams(params);
        return {
          first: async <T>() => {
            const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
            return (row ? { ...row } : null) as T | null;
          },
          all: async <T>() => (db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({ ...r })) as T[],
          run: async () => {
            const r = db.prepare(sql).run(...args);
            return { changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) || 0 };
          },
        };
      },
    }),
  };
}

// ---- the Kysely dialect Better Auth runs on over the local file ----

class LocalConnection implements DatabaseConnection {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const args = toParams(compiled.parameters);
    const upper = compiled.sql.trim().toUpperCase();
    const reads =
      upper.startsWith("SELECT") ||
      upper.startsWith("PRAGMA") ||
      upper.startsWith("EXPLAIN") ||
      upper.startsWith("WITH") ||
      upper.includes("RETURNING");
    if (reads) {
      const rows = (this.db.prepare(compiled.sql).all(...args) as Record<string, unknown>[]).map((r) => ({ ...r })) as R[];
      return { rows, numAffectedRows: BigInt(0), insertId: undefined };
    }
    const r = this.db.prepare(compiled.sql).run(...args);
    return {
      rows: [] as R[],
      numAffectedRows: BigInt(Number(r.changes)),
      insertId: Number(r.lastInsertRowid) ? BigInt(Number(r.lastInsertRowid)) : undefined,
    };
  }
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming queries.");
  }
}

class LocalDriver implements Driver {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new LocalConnection(this.db);
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class LocalAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true;
  }
}

class LocalDialect implements Dialect {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = openDb(file);
  }
  createDriver(): Driver {
    return new LocalDriver(this.db);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createAdapter(): DialectAdapter {
    return new LocalAdapter();
  }
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/** A Kysely instance over the local SQLite file (Better Auth takes this with `transaction: false`). */
export function createLocalKysely(file = process.env.EXPLANIMATE_D1_LOCAL_PATH ?? ":memory:"): Kysely<any> {
  return new Kysely({ dialect: new LocalDialect(file) });
}
