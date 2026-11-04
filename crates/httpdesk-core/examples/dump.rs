//! Debug helper: prints the parsed model of a `.http` file as JSON.
//! `cargo run -p httpdesk-core --example dump -- path/to/file.http`
fn main() {
    let path = std::env::args().nth(1).expect("usage: dump <file.http>");
    let text = std::fs::read_to_string(&path).expect("read file");
    println!("{}", serde_json::to_string_pretty(&httpdesk_core::parse(&text)).unwrap());
}
