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
        skipped: u64,
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
                let mut skipped_count = 0;
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
                        skipped_count += stats.skipped;
                        errors_count += stats.errors;
                    }
                    Err(e) => {
                        tracing::error!("Error extracting paths: {}", e);
                        errors_count += 1;
                    }
                }

                tracing::info!(
                    "Extract complete: extracted={} skipped={} errors={}",
                    extracted_count,
                    skipped_count,
                    errors_count
                );

                let res = ServerResponse::Extract {
                    id: req.id,
                    ok: true,
                    extracted: extracted_count,
                    skipped: skipped_count,
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
