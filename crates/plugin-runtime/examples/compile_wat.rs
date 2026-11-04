fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: compile_wat SOURCE.wat OUTPUT.wasm".into());
    }
    let bytes = wat::parse_file(&args[0])?;
    std::fs::write(&args[1], bytes)?;
    Ok(())
}
