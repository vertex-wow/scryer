use tracing_subscriber::fmt::writer::MakeWriterExt;
fn main() {
    let file = std::fs::File::create("test.log").unwrap();
    let writer = std::io::stderr.and(file);
    tracing_subscriber::fmt().with_writer(writer).init();
    tracing::info!("Hello world!");
}
