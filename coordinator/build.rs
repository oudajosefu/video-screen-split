use std::path::Path;

fn main() -> anyhow::Result<()> {
    let ui_dist = Path::new("../controller-ui/dist");
    if !ui_dist.exists() {
        std::fs::create_dir_all(ui_dist)?;
        std::fs::write(
            ui_dist.join("index.html"),
            "<!doctype html><html><body><p>controller-ui not built yet. \
             Run <code>npm run build:ui</code>.</p></body></html>",
        )?;
    }
    println!("cargo:rerun-if-changed=../controller-ui/dist");
    println!("cargo:rerun-if-changed=src/protocol.rs");
    Ok(())
}
