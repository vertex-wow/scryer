mod listfile_index;
mod server;

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use casc_lib::config::build_info::{list_products, parse_build_info};
use casc_lib::extract::{
    CascStorage, ExtractionConfig, OpenConfig, extract_all, extract_single_file, list_files,
};
use indicatif::{ProgressBar, ProgressStyle};

struct CustomFormatter {
    last_date: std::sync::Mutex<String>,
}

impl<S, N> tracing_subscriber::fmt::FormatEvent<S, N> for CustomFormatter
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    N: for<'a> tracing_subscriber::fmt::FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &tracing_subscriber::fmt::FmtContext<'_, S, N>,
        mut writer: tracing_subscriber::fmt::format::Writer<'_>,
        event: &tracing::Event<'_>,
    ) -> std::fmt::Result {
        let now = chrono::Local::now();
        let current_date = now.format("%Y-%m-%d").to_string();
        
        let mut last_date = self.last_date.lock().unwrap();
        if *last_date != current_date {
            if last_date.is_empty() {
                writeln!(writer, "{}:", current_date)?;
            } else {
                writeln!(writer, "\n{}:", current_date)?;
            }
            *last_date = current_date;
        }
        drop(last_date);

        let time = now.format("%H:%M:%S");
        let level = match *event.metadata().level() {
            tracing::Level::TRACE => "t",
            tracing::Level::DEBUG => "d",
            tracing::Level::INFO => "i",
            tracing::Level::WARN => "w",
            tracing::Level::ERROR => "e",
        };

        write!(writer, "{} [{}]: ", time, level)?;
        ctx.field_format().format_fields(writer.by_ref(), event)?;
        writeln!(writer)
    }
}

#[derive(Parser)]
#[command(name = "casc-extractor")]
#[command(about = "Extract files from World of Warcraft CASC archives")]
#[command(version)]
pub struct Cli {
    /// Increase log verbosity
    #[arg(short = 'v', long, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,

    /// Write logs to a file in addition to stderr
    #[arg(long, global = true)]
    pub log_file: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Commands,
}

/// Common CASC connection arguments shared across subcommands.
#[derive(clap::Args, Clone)]
pub struct CascArgs {
    /// WoW install directory
    #[arg(default_value = ".")]
    pub input: PathBuf,

    /// Product to extract (e.g. wow, wow_classic, wow_classic_era, wow_anniversary)
    #[arg(short = 'p', long)]
    pub product: Option<String>,

    /// Custom listfile path (skip download)
    #[arg(long)]
    pub listfile: Option<PathBuf>,

    /// Custom TACT keyfile path for encrypted files
    #[arg(long)]
    pub keyfile: Option<PathBuf>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Extract all files from CASC storage
    Extract {
        #[command(flatten)]
        casc: CascArgs,

        /// Output directory
        #[arg(short = 'o', long)]
        output: PathBuf,

        /// Locale filter
        #[arg(short = 'l', long, default_value = "enUS")]
        locale: String,

        /// Number of extraction threads
        #[arg(short = 'j', long)]
        threads: Option<usize>,

        /// Skip metadata index generation
        #[arg(long)]
        no_metadata: bool,

        /// Validate checksums during extraction
        #[arg(long)]
        verify: bool,

        /// Only extract files matching glob pattern
        #[arg(long)]
        filter: Option<String>,

        /// Skip encrypted files instead of erroring
        #[arg(long)]
        skip_encrypted: bool,
    },
    /// List files without extracting (dry run)
    List {
        #[command(flatten)]
        casc: CascArgs,

        /// Locale filter
        #[arg(short = 'l', long, default_value = "enUS")]
        locale: String,

        /// Only list files matching glob pattern
        #[arg(long)]
        filter: Option<String>,
    },
    /// Show CASC storage info
    Info {
        #[command(flatten)]
        casc: CascArgs,
    },
    /// Extract a single file by FileDataID or path
    Get {
        /// FileDataID (number) or file path
        target: String,

        /// WoW install directory
        #[arg(short = 'i', long, default_value = ".")]
        input: PathBuf,

        /// Output file path
        #[arg(short = 'o', long)]
        output: PathBuf,

        /// Product to extract (e.g. wow, wow_classic, wow_classic_era, wow_anniversary)
        #[arg(short = 'p', long)]
        product: Option<String>,

        /// Locale filter
        #[arg(short = 'l', long, default_value = "enUS")]
        locale: String,

        /// Custom listfile path (skip download)
        #[arg(long)]
        listfile: Option<PathBuf>,

        /// Custom TACT keyfile path for encrypted files
        #[arg(long)]
        keyfile: Option<PathBuf>,
    },
    /// Run as a long-lived stdio JSON server
    Server {
        /// WoW install directory
        #[arg(long, default_value = ".")]
        wow_dir: PathBuf,

        /// Output directory for extracted files
        #[arg(long)]
        out_dir: PathBuf,

        /// Custom listfile path (skip download)
        #[arg(long)]
        listfile: Option<PathBuf>,

        /// Idle timeout in seconds before self-exit
        #[arg(long, default_value = "20")]
        idle_timeout: u64,

        /// URLs to fetch community TACT keys from, tried in order
        #[arg(long, num_args = 0..)]
        tact_keys_urls: Vec<String>,
    },
}

fn main() {
    let cli = Cli::parse();

    let filter_str = match cli.verbose {
        0 => "info",
        1 => "debug",
        _ => "trace",
    };

    let env_filter = tracing_subscriber::EnvFilter::builder()
        .with_default_directive(filter_str.parse().unwrap())
        .from_env_lossy();

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr);

    if let Some(log_path) = &cli.log_file {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(log_path) {
            Ok(file) => {
                let file_layer = tracing_subscriber::fmt::layer()
                    .with_writer(file)
                    .with_ansi(false)
                    .event_format(CustomFormatter {
                        last_date: std::sync::Mutex::new(String::new()),
                    });
                
                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(stderr_layer)
                    .with(file_layer)
                    .init();
            }
            Err(e) => {
                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(stderr_layer)
                    .init();
                tracing::warn!("Failed to open log file {:?}: {}", log_path, e);
            }
        }
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(stderr_layer)
            .init();
    }

    {
        let mtime = std::env::current_exe()
            .and_then(|p| p.metadata())
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| {
                let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
                let utc = chrono::DateTime::from_timestamp(secs as i64, 0)?;
                Some(utc.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
            })
            .unwrap_or_else(|| "unknown".into());
        tracing::info!("binary built: {}", mtime);
    }

    if let Err(e) = run(cli) {
        tracing::error!("{}", e);
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> casc_lib::error::Result<()> {
    match cli.command {
        Commands::Extract {
            ref casc,
            ref output,
            ref locale,
            threads,
            no_metadata,
            verify,
            ref filter,
            skip_encrypted,
        } => {
            let open_config = make_open_config(casc, Some(output));
            let locale_val = parse_locale(locale);
            cmd_extract(
                casc,
                &open_config,
                output,
                locale_val,
                threads,
                no_metadata,
                verify,
                filter.as_deref(),
                skip_encrypted,
            )
        }
        Commands::List {
            ref casc,
            ref locale,
            ref filter,
        } => {
            let open_config = make_open_config(casc, None);
            let locale_val = parse_locale(locale);
            cmd_list(&open_config, locale_val, filter.as_deref())
        }
        Commands::Info { ref casc } => {
            let open_config = make_open_config(casc, None);
            cmd_info(&open_config)
        }
        Commands::Get {
            ref target,
            ref input,
            ref output,
            ref product,
            ref locale,
            ref listfile,
            ref keyfile,
        } => {
            // For `get`, output is a file path, not a directory - don't pass as output_dir.
            let open_config = OpenConfig {
                install_dir: input.clone(),
                product: product.clone(),
                keyfile: keyfile.clone(),
                listfile: listfile.clone(),
                output_dir: None,
                cdn_cache_dir: None,
                tact_keys_urls: vec![],
            };
            let locale_val = parse_locale(locale);
            cmd_get(&open_config, target, output, locale_val)
        }
        Commands::Server {
            wow_dir,
            out_dir,
            listfile,
            idle_timeout,
            tact_keys_urls,
        } => server::run_server(wow_dir, out_dir, listfile, idle_timeout, tact_keys_urls),
    }
}

fn make_open_config(casc: &CascArgs, output_dir: Option<&Path>) -> OpenConfig {
    OpenConfig {
        install_dir: casc.input.clone(),
        product: casc.product.clone(),
        keyfile: casc.keyfile.clone(),
        listfile: casc.listfile.clone(),
        output_dir: output_dir.map(Path::to_path_buf),
        cdn_cache_dir: None,
        tact_keys_urls: vec![],
    }
}

#[allow(clippy::too_many_arguments)]
fn cmd_extract(
    casc: &CascArgs,
    open_config: &OpenConfig,
    output_dir: &Path,
    locale: u32,
    threads: Option<usize>,
    no_metadata: bool,
    verify: bool,
    filter: Option<&str>,
    skip_encrypted: bool,
) -> casc_lib::error::Result<()> {
    tracing::info!("Opening CASC storage at {:?}...", casc.input);
    let storage = CascStorage::open(open_config)?;
    let info = storage.info();
    tracing::info!(
        "Build: {} | Product: {} | Version: {}",
        info.build_name,
        info.product,
        info.version
    );
    tracing::info!(
        "Encoding: {} entries | Root: {} entries ({}) | Paths: {} ({} TVFS)",
        info.encoding_entries,
        info.root_entries,
        info.root_format,
        info.resolver_paths,
        info.tvfs_paths,
    );

    let threads = threads.unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(4)
    });

    let config = ExtractionConfig {
        output_dir: output_dir.to_path_buf(),
        locale,
        threads,
        verify,
        skip_encrypted,
        filters: filter.map(String::from).into_iter().collect(),
        no_metadata,
    };

    let pb = ProgressBar::new(0);
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {pos}/{len} ({percent}%) {msg}",
        )
        .unwrap()
        .progress_chars("#>-"),
    );

    let progress_cb = move |done: u64, total: u64| {
        if pb.length() != Some(total) {
            pb.set_length(total);
        }
        pb.set_position(done);
    };

    tracing::info!("Starting extraction with {} threads...", threads);
    let stats = extract_all(&storage, &config, Some(&progress_cb))?;

    println!();
    println!("Extraction complete:");
    println!("  Total files:   {}", stats.total);
    println!("  Successful:    {}", stats.success);
    println!("  Errors:        {}", stats.errors);
    println!("  Unavailable:   {}", stats.unavailable);
    println!(
        "  Bytes written: {:.2} GB",
        stats.bytes_written as f64 / (1024.0 * 1024.0 * 1024.0)
    );

    Ok(())
}

fn cmd_list(
    open_config: &OpenConfig,
    locale: u32,
    filter: Option<&str>,
) -> casc_lib::error::Result<()> {
    tracing::info!("Opening CASC storage...");
    let storage = CascStorage::open(open_config)?;

    let files = list_files(&storage, locale, filter);
    for (fdid, path) in &files {
        println!("{}\t{}", fdid, path);
    }
    println!("---");
    println!("Total: {} files", files.len());

    Ok(())
}

fn cmd_info(open_config: &OpenConfig) -> casc_lib::error::Result<()> {
    // Parse .build.info first to discover available products
    let build_info_path = open_config.install_dir.join(".build.info");
    let build_info_content = std::fs::read_to_string(&build_info_path)?;
    let all_entries = parse_build_info(&build_info_content)?;

    // If no product specified, list all available products and exit
    if open_config.product.is_none() {
        let products = list_products(&all_entries);
        if products.is_empty() {
            println!("No products found in .build.info");
        } else {
            println!("Available products:");
            let max_name_len = products
                .iter()
                .map(|(name, _)| name.len())
                .max()
                .unwrap_or(0);
            for (name, version) in &products {
                if version.is_empty() {
                    println!("  {:<width$}", name, width = max_name_len);
                } else {
                    println!("  {:<width$}  {}", name, version, width = max_name_len);
                }
            }
            println!();
            println!("Use -p <product> to select a product for detailed info.");
        }
        return Ok(());
    }

    tracing::info!("Opening CASC storage...");
    let storage = CascStorage::open(open_config)?;
    let info = storage.info();

    println!("CASC Storage Info");
    println!("  Build:          {}", info.build_name);
    println!("  Product:        {}", info.product);
    println!("  Version:        {}", info.version);
    println!("  Root format:    {}", info.root_format);
    println!("  Encoding:       {} entries", info.encoding_entries);
    println!("  Root:           {} entries", info.root_entries);
    println!("  Index:          {} entries", info.index_entries);
    println!("  Resolver:       {} paths ({} TVFS)", info.resolver_paths, info.tvfs_paths);

    Ok(())
}

fn cmd_get(
    open_config: &OpenConfig,
    target: &str,
    output: &Path,
    locale: u32,
) -> casc_lib::error::Result<()> {
    tracing::info!("Opening CASC storage...");
    let storage = CascStorage::open(open_config)?;

    let size = extract_single_file(&storage, target, output, locale)?;
    println!("Extracted {} ({} bytes) to {:?}", target, size, output);

    Ok(())
}

fn parse_locale(s: &str) -> u32 {
    match s.to_lowercase().as_str() {
        "enus" | "en_us" => 0x2,
        "kokr" | "ko_kr" => 0x4,
        "frfr" | "fr_fr" => 0x10,
        "dede" | "de_de" => 0x20,
        "zhcn" | "zh_cn" => 0x40,
        "eses" | "es_es" => 0x80,
        "zhtw" | "zh_tw" => 0x100,
        "engb" | "en_gb" => 0x200,
        "ruru" | "ru_ru" => 0x2000,
        "ptbr" | "pt_br" => 0x4000,
        "itit" | "it_it" => 0x8000,
        "all" => 0xFFFFFFFF,
        _ => {
            // Try parsing as raw hex/decimal
            if let Some(hex) = s.strip_prefix("0x") {
                u32::from_str_radix(hex, 16).unwrap_or(0x2)
            } else {
                s.parse::<u32>().unwrap_or(0x2)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn cli_parse_extract_defaults() {
        let cli = Cli::try_parse_from(["casc-extractor", "extract", "-o", "out"]).unwrap();
        match cli.command {
            Commands::Extract {
                casc,
                output,
                locale,
                verify,
                skip_encrypted,
                ..
            } => {
                assert_eq!(casc.input, PathBuf::from("."));
                assert_eq!(locale, "enUS");
                assert!(!verify);
                assert!(!skip_encrypted);
                assert_eq!(output, PathBuf::from("out"));
            }
            _ => panic!("expected Extract"),
        }
    }

    #[test]
    fn cli_parse_extract_all_flags() {
        let cli = Cli::try_parse_from([
            "casc-extractor",
            "extract",
            "E:\\WoW",
            "-o",
            "F:\\output",
            "-p",
            "wow",
            "-l",
            "deDE",
            "-j",
            "8",
            "-vv",
            "--verify",
            "--skip-encrypted",
            "--no-metadata",
            "--filter",
            "world/maps/**",
            "--listfile",
            "C:\\listfile.csv",
        ])
        .unwrap();
        assert_eq!(cli.verbose, 2);
        match cli.command {
            Commands::Extract {
                casc,
                output,
                locale,
                threads,
                verify,
                skip_encrypted,
                no_metadata,
                filter,
            } => {
                assert_eq!(casc.input, PathBuf::from("E:\\WoW"));
                assert_eq!(output, PathBuf::from("F:\\output"));
                assert_eq!(casc.product, Some("wow".into()));
                assert_eq!(locale, "deDE");
                assert_eq!(threads, Some(8));
                assert!(verify);
                assert!(skip_encrypted);
                assert!(no_metadata);
                assert_eq!(filter, Some("world/maps/**".into()));
                assert_eq!(casc.listfile, Some(PathBuf::from("C:\\listfile.csv")));
            }
            _ => panic!("expected Extract"),
        }
    }

    #[test]
    fn cli_parse_info() {
        let cli = Cli::try_parse_from(["casc-extractor", "info"]).unwrap();
        assert!(matches!(cli.command, Commands::Info { .. }));
    }

    #[test]
    fn cli_parse_get() {
        let cli = Cli::try_parse_from(["casc-extractor", "get", "12345", "-o", "out.bin"]).unwrap();
        match &cli.command {
            Commands::Get {
                target,
                input,
                output,
                ..
            } => {
                assert_eq!(target, "12345");
                assert_eq!(input, &PathBuf::from("."));
                assert_eq!(output, &PathBuf::from("out.bin"));
            }
            _ => panic!("expected Get"),
        }
    }

    #[test]
    fn cli_parse_list() {
        let cli = Cli::try_parse_from(["casc-extractor", "list"]).unwrap();
        assert!(matches!(cli.command, Commands::List { .. }));
    }

    #[test]
    fn parse_locale_known() {
        assert_eq!(parse_locale("enUS"), 0x2);
        assert_eq!(parse_locale("deDE"), 0x20);
        assert_eq!(parse_locale("all"), 0xFFFFFFFF);
    }

    #[test]
    fn parse_locale_case_insensitive() {
        assert_eq!(parse_locale("enus"), 0x2);
        assert_eq!(parse_locale("ENUS"), 0x2);
    }

    #[test]
    fn parse_locale_hex_raw() {
        assert_eq!(parse_locale("0x2"), 0x2);
        assert_eq!(parse_locale("0x20"), 0x20);
    }

    #[test]
    fn cli_parse_with_keyfile() {
        let cli = Cli::try_parse_from([
            "casc-extractor",
            "extract",
            "-o",
            "out",
            "--keyfile",
            "keys.txt",
        ])
        .unwrap();
        match cli.command {
            Commands::Extract { casc, .. } => {
                assert_eq!(casc.keyfile, Some(PathBuf::from("keys.txt")));
            }
            _ => panic!("expected Extract"),
        }
    }
}
