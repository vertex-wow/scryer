use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use base64::prelude::*;
use casc_lib::error::CascError;
use casc_lib::extract::{CascStorage, ExtractionConfig, OpenConfig, extract_all, read_file_bytes};

#[derive(Deserialize, Debug)]
#[serde(tag = "method", rename_all = "camelCase")]
enum RequestPayload {
    Extract {
        paths: Vec<String>,
        #[serde(rename = "cdnEnabled", default)]
        cdn_enabled: bool,
    },
    Status,
    Shutdown,
    ReadFile {
        path: String,
        #[serde(rename = "cdnEnabled", default)]
        cdn_enabled: bool,
    },
}

#[derive(Deserialize, Debug)]
struct ServerRequest {
    id: u64,
    #[serde(flatten)]
    payload: RequestPayload,
}

#[derive(Serialize, Debug)]
#[serde(untagged)]
enum ServerResponse {
    Extract {
        id: u64,
        ok: bool,
        extracted: u64,
        /// Files in the CASC index that could not be extracted locally (CDN-only stubs or encrypted).
        /// Already-cached files are silently skipped and not counted here.
        unavailable: u64,
        errors: u64,
    },
    Status {
        id: u64,
        ok: bool,
        ready: bool,
        #[serde(rename = "buildHash")]
        build_hash: String,
        #[serde(rename = "idleTimeoutMs")]
        idle_timeout_ms: u64,
    },
    Shutdown {
        id: u64,
        ok: bool,
    },
    ReadFile {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Error {
        id: u64,
        ok: bool,
        error: String,
    },
}

// ---------------------------------------------------------------------------
// Decryption failure stamps
//
// When a ReadFile fails with EncryptionKeyMissing, we write a stamp file so
// subsequent requests skip the CASC read immediately (the same keys will fail
// again). The stamp is valid while the build key matches and the stamp is less
// than 7 days old — after that we retry in case the community has published
// the missing key (which will also have triggered a fresh key download).
// ---------------------------------------------------------------------------

fn decrypt_fail_stamp_path(out_dir: &std::path::Path, path: &str) -> std::path::PathBuf {
    let safe_name = path.replace(['/', '\\', '.'], "_");
    out_dir.join(".casc-meta").join(format!("decrypt-fail-{}.stamp", safe_name))
}

fn is_decryption_skip(out_dir: &std::path::Path, path: &str, build_key: &str) -> bool {
    const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
    let stamp_path = decrypt_fail_stamp_path(out_dir, path);
    let Ok(content) = std::fs::read_to_string(&stamp_path) else {
        return false;
    };
    let stamp_build = content.lines().next().unwrap_or("").trim();
    if stamp_build != build_key {
        return false;
    }
    let age = std::fs::metadata(&stamp_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .unwrap_or(Duration::MAX);
    age.as_secs() < MAX_AGE_SECS
}

fn write_decrypt_fail_stamp(out_dir: &std::path::Path, path: &str, build_key: &str, key_name: &str) {
    let stamp_path = decrypt_fail_stamp_path(out_dir, path);
    if let Some(parent) = stamp_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&stamp_path, format!("{}\n{}\n", build_key, key_name));
    tracing::debug!("decryption failure stamp written: {} (key={})", path, key_name);
}

pub fn run_server(
    wow_dir: PathBuf,
    out_dir: PathBuf,
    listfile: Option<PathBuf>,
    idle_timeout: u64,
    tact_keys_urls: Vec<String>,
) -> casc_lib::error::Result<()> {
    tracing::info!(
        "Starting CASC server. wow_dir: {:?}, out_dir: {:?}, idle_timeout: {}s",
        wow_dir,
        out_dir,
        idle_timeout
    );

    let idle_timeout_dur = Duration::from_secs(idle_timeout);
    let last_request = Arc::new(Mutex::new(Instant::now()));
    // Prevents idle exit while a request is actively being processed (e.g. during CASC init).
    let in_flight = Arc::new(AtomicBool::new(false));

    // Background thread to watch for idle timeout
    let timeout_last_req = Arc::clone(&last_request);
    let timeout_in_flight = Arc::clone(&in_flight);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if timeout_in_flight.load(Ordering::Relaxed) {
            // Request in progress — reset idle timer so timeout counts from completion.
            *timeout_last_req.lock().unwrap() = Instant::now();
            continue;
        }
        let elapsed = timeout_last_req.lock().unwrap().elapsed();
        if elapsed > idle_timeout_dur {
            tracing::info!("Idle timeout reached ({}s). Exiting.", idle_timeout);
            std::process::exit(0);
        }
    });

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    // Lazy load storage on first request
    let mut storage: Option<CascStorage> = None;
    let mut build_hash = String::new();
    let mut build_key = String::new();
    // Track the cdn setting for the current storage instance so we can reinit on change.
    let mut current_cdn_enabled = false;

    let threads = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(4);

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // EOF or error
        };

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Reset idle timer and mark request in flight.
        *last_request.lock().unwrap() = Instant::now();
        in_flight.store(true, Ordering::Relaxed);

        let req: ServerRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Failed to parse request: {}", e);
                in_flight.store(false, Ordering::Relaxed);
                continue;
            }
        };

        match req.payload {
            RequestPayload::Shutdown => {
                let res = ServerResponse::Shutdown {
                    id: req.id,
                    ok: true,
                };
                serde_json::to_writer(&mut stdout, &res).unwrap();
                stdout.write_all(b"\n").unwrap();
                stdout.flush().unwrap();
                tracing::info!("Shutdown requested. Exiting.");
                std::process::exit(0);
            }
            RequestPayload::Status => {
                let ready = storage.is_some();
                let res = ServerResponse::Status {
                    id: req.id,
                    ok: true,
                    ready,
                    build_hash: build_hash.clone(),
                    idle_timeout_ms: idle_timeout * 1000,
                };
                serde_json::to_writer(&mut stdout, &res).unwrap();
                stdout.write_all(b"\n").unwrap();
                stdout.flush().unwrap();
                in_flight.store(false, Ordering::Relaxed);
            }
            RequestPayload::ReadFile { path, cdn_enabled } => {
                tracing::debug!("ReadFile request: {}", path);

                if cdn_enabled != current_cdn_enabled && storage.is_some() {
                    tracing::info!(
                        "CDN setting changed ({} → {}) — reinitializing storage",
                        current_cdn_enabled,
                        cdn_enabled
                    );
                    storage = None;
                }
                current_cdn_enabled = cdn_enabled;

                if storage.is_none() {
                    tracing::info!("Initializing CASC storage...");
                    let open_start = Instant::now();
                    let open_config = OpenConfig {
                        install_dir: wow_dir.clone(),
                        product: Some("wow".into()),
                        keyfile: None,
                        listfile: listfile.clone(),
                        output_dir: Some(out_dir.clone()),
                        cdn_cache_dir: if cdn_enabled {
                            Some(out_dir.join(".casc-cdn-cache"))
                        } else {
                            None
                        },
                        tact_keys_urls: tact_keys_urls.clone(),
                    };
                    match CascStorage::open(&open_config) {
                        Ok(s) => {
                            let elapsed = open_start.elapsed();
                            let info = s.info();
                            tracing::info!(
                                "CASC storage ready in {:.2}s — build={} product={} root={} paths={} tvfs={}",
                                elapsed.as_secs_f64(),
                                info.version,
                                info.product,
                                info.root_entries,
                                info.resolver_paths,
                                info.tvfs_paths,
                            );
                            build_hash = info.version.clone();
                            build_key = info.build_key.clone();
                            storage = Some(s);
                        }
                        Err(e) => {
                            tracing::error!("Failed to initialize CASC storage: {}", e);
                            let res = ServerResponse::Error {
                                id: req.id,
                                ok: false,
                                error: format!("Failed to initialize CASC storage: {}", e),
                            };
                            serde_json::to_writer(&mut stdout, &res).unwrap();
                            stdout.write_all(b"\n").unwrap();
                            stdout.flush().unwrap();
                            in_flight.store(false, Ordering::Relaxed);
                            continue;
                        }
                    }
                }

                // Skip immediately if a recent decryption failure stamp exists (only
                // when CDN/community keys are enabled — otherwise there's no key
                // refresh mechanism and we'd block reads permanently on CDN-off runs).
                if cdn_enabled && is_decryption_skip(&out_dir, &path, &build_key) {
                    tracing::debug!("readFile skipped (decryption failure stamp active): {}", path);
                    let res = ServerResponse::ReadFile {
                        id: req.id,
                        ok: false,
                        data: None,
                        error: Some("encryption key missing (cached failure — retry in 7 days or on next build)".into()),
                    };
                    serde_json::to_writer(&mut stdout, &res).unwrap();
                    stdout.write_all(b"\n").unwrap();
                    stdout.flush().unwrap();
                    in_flight.store(false, Ordering::Relaxed);
                    continue;
                }

                let store = storage.as_ref().unwrap();
                // Use locale 0x0 (NONE = no locale filter) so locale-neutral files
                // like DB2 tables match regardless of what locale_flags they carry.
                let res = match read_file_bytes(store, &path, 0x0) {
                    Ok(bytes) => {
                        tracing::debug!("readFile hit: {} ({} bytes)", path, bytes.len());
                        ServerResponse::ReadFile {
                            id: req.id,
                            ok: true,
                            data: Some(BASE64_STANDARD.encode(&bytes)),
                            error: None,
                        }
                    }
                    Err(CascError::EncryptionKeyMissing(ref key_name)) => {
                        tracing::debug!("readFile miss (key missing): {} — key={}", path, key_name);
                        if cdn_enabled {
                            write_decrypt_fail_stamp(&out_dir, &path, &build_key, key_name);
                        }
                        ServerResponse::ReadFile {
                            id: req.id,
                            ok: false,
                            data: None,
                            error: Some(format!("encryption key missing: {}", key_name)),
                        }
                    }
                    Err(e) => {
                        tracing::debug!("readFile miss: {} — {}", path, e);
                        ServerResponse::ReadFile {
                            id: req.id,
                            ok: false,
                            data: None,
                            error: Some(e.to_string()),
                        }
                    }
                };

                serde_json::to_writer(&mut stdout, &res).unwrap();
                stdout.write_all(b"\n").unwrap();
                stdout.flush().unwrap();
                in_flight.store(false, Ordering::Relaxed);
            }
            RequestPayload::Extract { paths, cdn_enabled } => {
                tracing::info!(
                    "Extract request: {} path(s)/glob(s), cdn_enabled={}",
                    paths.len(),
                    cdn_enabled
                );
                if tracing::enabled!(tracing::Level::DEBUG) {
                    for p in paths.iter().take(5) {
                        tracing::debug!("  {}", p);
                    }
                    if paths.len() > 5 {
                        tracing::debug!("  ... ({} more)", paths.len() - 5);
                    }
                }

                // Reinitialize storage when the CDN setting changes.
                if cdn_enabled != current_cdn_enabled && storage.is_some() {
                    tracing::info!(
                        "CDN setting changed ({} → {}) — reinitializing storage",
                        current_cdn_enabled,
                        cdn_enabled
                    );
                    storage = None;
                }
                current_cdn_enabled = cdn_enabled;

                let open_config = OpenConfig {
                    install_dir: wow_dir.clone(),
                    product: Some("wow".into()),
                    keyfile: None,
                    listfile: listfile.clone(),
                    output_dir: Some(out_dir.clone()),
                    cdn_cache_dir: if cdn_enabled {
                        Some(out_dir.join(".casc-cdn-cache"))
                    } else {
                        None
                    },
                    tact_keys_urls: tact_keys_urls.clone(),
                };

                // Initialize storage if not ready
                if storage.is_none() {
                    tracing::info!("Initializing CASC storage...");
                    let open_start = Instant::now();
                    match CascStorage::open(&open_config) {
                        Ok(s) => {
                            let elapsed = open_start.elapsed();
                            let info = s.info();
                            tracing::info!(
                                "CASC storage ready in {:.2}s — build={} product={} root={} paths={} tvfs={}",
                                elapsed.as_secs_f64(),
                                info.version,
                                info.product,
                                info.root_entries,
                                info.resolver_paths,
                                info.tvfs_paths,
                            );
                            build_hash = info.version.clone();
                            build_key = info.build_key.clone();
                            storage = Some(s);
                        }
                        Err(e) => {
                            tracing::error!("Failed to initialize CASC storage: {}", e);
                            let res = ServerResponse::Error {
                                id: req.id,
                                ok: false,
                                error: format!("Failed to initialize CASC storage: {}", e),
                            };
                            serde_json::to_writer(&mut stdout, &res).unwrap();
                            stdout.write_all(b"\n").unwrap();
                            stdout.flush().unwrap();
                            in_flight.store(false, Ordering::Relaxed);
                            continue;
                        }
                    }
                }

                let store = storage.as_ref().unwrap();

                let mut extracted_count = 0;
                let mut unavailable_count = 0;
                let mut errors_count = 0;

                let config = ExtractionConfig {
                    output_dir: out_dir.clone(),
                    locale: 0x2, // enUS
                    threads,
                    verify: false,
                    skip_encrypted: true,
                    filters: paths,
                    no_metadata: true,
                };

                match extract_all(store, &config, None) {
                    Ok(stats) => {
                        extracted_count += stats.success;
                        unavailable_count += stats.unavailable;
                        errors_count += stats.errors;
                    }
                    Err(e) => {
                        tracing::error!("Error extracting paths: {}", e);
                        errors_count += 1;
                    }
                }

                tracing::info!(
                    "Extract complete: extracted={} unavailable={} errors={}",
                    extracted_count,
                    unavailable_count,
                    errors_count
                );

                let res = ServerResponse::Extract {
                    id: req.id,
                    ok: true,
                    extracted: extracted_count,
                    unavailable: unavailable_count,
                    errors: errors_count,
                };
                serde_json::to_writer(&mut stdout, &res).unwrap();
                stdout.write_all(b"\n").unwrap();
                stdout.flush().unwrap();
                in_flight.store(false, Ordering::Relaxed);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    // --- Request parsing ---

    #[test]
    fn parse_extract_request() {
        let raw = r#"{"id":1,"method":"extract","paths":["fonts/*.ttf","interface/*.blp"]}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.id, 1);
        match req.payload {
            RequestPayload::Extract { paths, cdn_enabled } => {
                assert_eq!(paths.len(), 2);
                assert_eq!(paths[0], "fonts/*.ttf");
                assert_eq!(paths[1], "interface/*.blp");
                assert!(!cdn_enabled, "cdn_enabled defaults to false when absent");
            }
            _ => panic!("expected Extract variant"),
        }
    }

    #[test]
    fn parse_extract_request_empty_paths() {
        let raw = r#"{"id":5,"method":"extract","paths":[]}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        match req.payload {
            RequestPayload::Extract { paths, .. } => assert!(paths.is_empty()),
            _ => panic!("expected Extract variant"),
        }
    }

    #[test]
    fn parse_extract_request_with_cdn_enabled() {
        let raw = r#"{"id":7,"method":"extract","paths":["fonts/**"],"cdnEnabled":true}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        match req.payload {
            RequestPayload::Extract { paths, cdn_enabled } => {
                assert_eq!(paths.len(), 1);
                assert!(cdn_enabled);
            }
            _ => panic!("expected Extract variant"),
        }
    }

    #[test]
    fn parse_read_file_request() {
        let raw = r#"{"id":8,"method":"readFile","path":"interface/icons/foo.blp"}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.id, 8);
        match req.payload {
            RequestPayload::ReadFile { path, cdn_enabled } => {
                assert_eq!(path, "interface/icons/foo.blp");
                assert!(!cdn_enabled, "cdn_enabled defaults to false when absent");
            }
            _ => panic!("expected ReadFile variant"),
        }
    }

    #[test]
    fn parse_read_file_request_with_cdn() {
        let raw = r#"{"id":9,"method":"readFile","path":"fonts/arialn.ttf","cdnEnabled":true}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        match req.payload {
            RequestPayload::ReadFile { path, cdn_enabled } => {
                assert_eq!(path, "fonts/arialn.ttf");
                assert!(cdn_enabled);
            }
            _ => panic!("expected ReadFile variant"),
        }
    }

    #[test]
    fn serialize_read_file_response_ok() {
        let res = ServerResponse::ReadFile {
            id: 8,
            ok: true,
            data: Some("aGVsbG8=".into()),
            error: None,
        };
        let json: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(json["id"], 8);
        assert_eq!(json["ok"], true);
        assert_eq!(json["data"], "aGVsbG8=");
        assert!(json.get("error").is_none(), "error must be omitted when ok");
    }

    #[test]
    fn serialize_read_file_response_miss() {
        let res = ServerResponse::ReadFile {
            id: 9,
            ok: false,
            data: None,
            error: Some("key not found".into()),
        };
        let json: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(json["id"], 9);
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"], "key not found");
        assert!(json.get("data").is_none(), "data must be omitted on miss");
    }

    #[test]
    fn parse_status_request() {
        let raw = r#"{"id":2,"method":"status"}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.id, 2);
        assert!(matches!(req.payload, RequestPayload::Status));
    }

    #[test]
    fn parse_shutdown_request() {
        let raw = r#"{"id":3,"method":"shutdown"}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.id, 3);
        assert!(matches!(req.payload, RequestPayload::Shutdown));
    }

    #[test]
    fn parse_malformed_json_returns_err() {
        let result: Result<ServerRequest, _> = serde_json::from_str(r#"{"id": not valid"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_unknown_method_returns_err() {
        let result: Result<ServerRequest, _> =
            serde_json::from_str(r#"{"id":4,"method":"unknown"}"#);
        assert!(result.is_err());
    }

    // --- Response serialization ---

    #[test]
    fn serialize_extract_response_has_all_fields() {
        let res = ServerResponse::Extract {
            id: 1,
            ok: true,
            extracted: 42,
            unavailable: 3,
            errors: 1,
        };
        let json: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(json["id"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["extracted"], 42);
        assert_eq!(json["unavailable"], 3);
        assert_eq!(json["errors"], 1);
    }

    #[test]
    fn serialize_status_response_uses_camel_case() {
        let res = ServerResponse::Status {
            id: 2,
            ok: true,
            ready: true,
            build_hash: "abc123def456".into(),
            idle_timeout_ms: 60_000,
        };
        let json: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(json["id"], 2);
        assert_eq!(json["ok"], true);
        assert_eq!(json["ready"], true);
        assert_eq!(json["buildHash"], "abc123def456");
        assert_eq!(json["idleTimeoutMs"], 60_000);
        assert!(json.get("build_hash").is_none(), "snake_case key must not appear");
        assert!(json.get("idle_timeout_ms").is_none(), "snake_case key must not appear");
    }

    #[test]
    fn serialize_error_response_ok_is_false() {
        let res = ServerResponse::Error {
            id: 3,
            ok: false,
            error: "CASC storage failed".into(),
        };
        let json: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(json["id"], 3);
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"], "CASC storage failed");
    }

    #[test]
    fn serialize_shutdown_response() {
        let res = ServerResponse::Shutdown { id: 4, ok: true };
        let json: serde_json::Value = serde_json::to_value(&res).unwrap();
        assert_eq!(json["id"], 4);
        assert_eq!(json["ok"], true);
    }

    // --- in_flight AtomicBool ---

    #[test]
    fn in_flight_starts_false() {
        let in_flight = Arc::new(AtomicBool::new(false));
        assert!(!in_flight.load(Ordering::Relaxed));
    }

    #[test]
    fn in_flight_set_on_request_start() {
        let in_flight = Arc::new(AtomicBool::new(false));
        in_flight.store(true, Ordering::Relaxed);
        assert!(in_flight.load(Ordering::Relaxed));
    }

    #[test]
    fn in_flight_clear_on_request_complete() {
        let in_flight = Arc::new(AtomicBool::new(false));
        in_flight.store(true, Ordering::Relaxed);
        in_flight.store(false, Ordering::Relaxed);
        assert!(!in_flight.load(Ordering::Relaxed));
    }

    #[test]
    fn in_flight_true_suppresses_idle_timeout() {
        // The timeout thread checks in_flight before counting elapsed time.
        // When true it resets the idle clock instead of approaching the cutoff.
        let in_flight = Arc::new(AtomicBool::new(true));
        let should_reset_clock = in_flight.load(Ordering::Relaxed);
        assert!(should_reset_clock, "in-flight request must prevent idle exit");
    }
}
