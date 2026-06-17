/**
 * Read-only client for the SQLite listfile index.
 *
 * The index is written by the Rust asset server after each listfile
 * download and lives at <cascMetaDir>/listfile.db. Node queries it for
 * sub-millisecond FileDataID → path lookups instead of scanning the full
 * 2M-row CSV.
 *
 * Falls back gracefully to null when the DB is absent (server not yet run,
 * or no WoW install configured). Callers must handle that case.
 */

import * as fs from "fs";
import { DatabaseSync, StatementSync } from "node:sqlite";

export class ListfileIndex {
  private readonly db: DatabaseSync;
  private readonly stmtByFdid: StatementSync;
  private readonly stmtByPath: StatementSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtByFdid = db.prepare("SELECT path FROM listfile WHERE id = ?");
    this.stmtByPath = db.prepare("SELECT id   FROM listfile WHERE path = ?");
  }

  /**
   * Open the SQLite listfile index at `dbPath`.
   * Returns `null` if the file does not exist or cannot be opened.
   */
  static open(dbPath: string): ListfileIndex | null {
    if (!fs.existsSync(dbPath)) return null;
    try {
      const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      return new ListfileIndex(db);
    } catch {
      return null;
    }
  }

  /** FileDataID → original-case path, or `null` on miss. */
  lookupPath(fdid: number): string | null {
    const row = this.stmtByFdid.get(fdid) as { path: string } | undefined;
    return row?.path ?? null;
  }

  /** Case-insensitive path → FileDataID, or `null` on miss. */
  lookupFdid(path: string): number | null {
    const row = this.stmtByPath.get(path) as { id: number } | undefined;
    return row?.id ?? null;
  }

  close(): void {
    this.db.close();
  }
}
