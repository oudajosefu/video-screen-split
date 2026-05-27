mod mdns;
mod protocol;
mod state;
mod static_ui;
mod ws;

use axum::routing::{any, get};
use axum::Router;
use clap::Parser;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(version, about = "video-screen-split coordinator")]
struct Args {
    /// Port to bind the HTTP + WebSocket server on.
    #[arg(long, default_value_t = 8787)]
    port: u16,
    /// Disable mDNS advertisement (use this if you'll point display apps at
    /// the coordinator URL manually).
    #[arg(long, default_value_t = false)]
    no_mdns: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    let state = Arc::new(state::StateActor::spawn());

    let _mdns_daemon = if args.no_mdns {
        None
    } else {
        Some(mdns::advertise(args.port)?)
    };

    let app = Router::new()
        .route("/", get(static_ui::index))
        .route("/ws", any(ws::ws_handler))
        .route("/assets/*path", get(static_ui::asset_at))
        .fallback(get(static_ui::asset))
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], args.port));
    info!(%addr, "coordinator listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
