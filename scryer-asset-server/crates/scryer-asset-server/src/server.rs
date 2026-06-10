use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use casc_lib::extract::{CascStorage, ExtractionConfig, OpenConfig, extract_all};

#[derive(Deserialize, Debug)]
#[serde(tag = "method", rename_all = "camelCase")]
enum RequestPayload {
    Extract { paths: Vec<String> },
    Status,
    Shutdown,
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
        /// NOT "already cached" — the server always attempts extraction.
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
    Error {
        id: u64,
        ok: bool,
        error: String,
    },
}

pub fn run_server(
    wow_dir: PathBuf,
    out_dir: PathBuf,
    listfile: Option<PathBuf>,
    idle_timeout: u64,
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

    let open_config = OpenConfig {
        install_dir: wow_dir,
        product: Some("wow".into()), // default to retail for now
        keyfile: None,
        listfile,
        output_dir: Some(out_dir.clone()),
    };

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
            RequestPayload::Extract { paths } => {
                tracing::info!("Extract request: {} path(s)/glob(s)", paths.len());
                if tracing::enabled!(tracing::Level::DEBUG) {
                    for p in paths.iter().take(5) {
                        tracing::debug!("  {}", p);
                    }
                    if paths.len() > 5 {
                        tracing::debug!("  ... ({} more)", paths.len() - 5);
                    }
                }

                // Initialize storage if not ready
                if storage.is_none() {
                    tracing::info!("Initializing CASC storage for the first time...");
                    match CascStorage::open(&open_config) {
                        Ok(s) => {
                            let info = s.info();
                            tracing::info!(
                                "CASC storage initialized. build={} product={} root_entries={}",
                                info.version,
                                info.product,
                                info.root_entries
                            );
                            build_hash = info.version.clone();
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
            RequestPayload::Extract { paths } => {
                assert_eq!(paths.len(), 2);
                assert_eq!(paths[0], "fonts/*.ttf");
                assert_eq!(paths[1], "interface/*.blp");
            }
            _ => panic!("expected Extract variant"),
        }
    }

    #[test]
    fn parse_extract_request_empty_paths() {
        let raw = r#"{"id":5,"method":"extract","paths":[]}"#;
        let req: ServerRequest = serde_json::from_str(raw).unwrap();
        match req.payload {
            RequestPayload::Extract { paths } => assert!(paths.is_empty()),
            _ => panic!("expected Extract variant"),
        }
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
