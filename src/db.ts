import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Thin wrapper: foreign keys on, WAL on, typed helpers. */
export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode=WAL");
    this.raw.exec("PRAGMA foreign_keys=ON");
    this.raw.exec("PRAGMA busy_timeout=30000");
  }

  migrate(): void {
    const sql = readFileSync(join(here, "schema.sql"), "utf-8");
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function nowMs(): number {
  return Date.now();
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
