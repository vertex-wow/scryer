use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{Connection, params};

use casc_lib::listfile::parser::Listfile;

pub fn db_path(out_dir: &Path) -> PathBuf {
    out_dir.join(".casc-meta").join("listfile.db")
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

pub fn is_stale(db: &Path, csv: &Path) -> bool {
    match (file_mtime(db), file_mtime(csv)) {
        (Some(db_t), Some(csv_t)) => csv_t > db_t,
        _ => true,
    }
}

/// Build (or rebuild) the SQLite listfile index if the CSV is newer than the DB.
///
/// Schema: `listfile(id INTEGER PRIMARY KEY, path TEXT NOT NULL COLLATE NOCASE)`
///
/// Writes to a `.db.tmp` sidecar first, then renames atomically so a partially-
/// written DB is never visible to readers.
///
/// Returns `true` if the index was rebuilt, `false` if it was already fresh.
pub fn build_if_stale(lf: &Listfile, csv_path: &Path, db: &Path) -> rusqlite::Result<bool> {
    if !is_stale(db, csv_path) {
        tracing::debug!("listfile.db is fresh — skipping rebuild");
        return Ok(false);
    }

    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(format!("create_dir_all: {e}")),
            ))?;
    }

    let tmp = db.with_extension("db.tmp");
    tracing::info!("listfile: building SQLite index ({} entries)…", lf.len());

    {
        let conn = Connection::open(&tmp)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous  = NORMAL;
             CREATE TABLE IF NOT EXISTS listfile (
                 id   INTEGER PRIMARY KEY,
                 path TEXT    NOT NULL COLLATE NOCASE
             );",
        )?;

        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt =
                conn.prepare("INSERT OR REPLACE INTO listfile (id, path) VALUES (?1, ?2)")?;
            for (fdid, path) in lf.iter() {
                stmt.execute(params![fdid, path])?;
            }
        }
        tx.commit()?;
    }

    std::fs::rename(&tmp, db).map_err(|e| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
            Some(format!("rename tmp→db: {e}")),
        )
    })?;

    tracing::info!("listfile: SQLite index written to {}", db.display());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_listfile(entries: &[(u32, &str)]) -> Listfile {
        let csv: String = entries
            .iter()
            .map(|(id, p)| format!("{};{}\n", id, p))
            .collect();
        Listfile::parse(&csv)
    }

    #[test]
    fn builds_db_and_is_queryable() {
        let dir = std::env::temp_dir()
            .join(format!("lfidx-test-build-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let csv = dir.join("listfile.csv");
        std::fs::write(&csv, "53;Cameras/FlyBy.m2\n69;Creature/Bear/Bear.m2\n").unwrap();

        let db = db_path(&dir.join("..")); // will be dir/../.casc-meta/listfile.db
        let db = dir.join("listfile.db");

        let lf = make_listfile(&[(53, "Cameras/FlyBy.m2"), (69, "Creature/Bear/Bear.m2")]);
        let rebuilt = build_if_stale(&lf, &csv, &db).unwrap();
        assert!(rebuilt, "first build should return true");
        assert!(db.exists());

        let conn = Connection::open_with_flags(
            &db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let path: String = conn
            .query_row("SELECT path FROM listfile WHERE id = 53", [], |r| r.get(0))
            .unwrap();
        assert_eq!(path, "Cameras/FlyBy.m2");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_rebuild_when_fresh() {
        let dir = std::env::temp_dir()
            .join(format!("lfidx-test-fresh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let csv = dir.join("listfile.csv");
        std::fs::write(&csv, "1;A.m2\n").unwrap();
        let db = dir.join("listfile.db");

        let lf = make_listfile(&[(1, "A.m2")]);
        build_if_stale(&lf, &csv, &db).unwrap();

        // Touch the DB to make it newer than the CSV.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&db, std::fs::read(&db).unwrap()).unwrap();

        let rebuilt = build_if_stale(&lf, &csv, &db).unwrap();
        assert!(!rebuilt, "should be fresh after mtime update");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn db_path_is_under_casc_meta() {
        let base = PathBuf::from("/some/out");
        assert_eq!(db_path(&base), base.join(".casc-meta").join("listfile.db"));
    }
}
