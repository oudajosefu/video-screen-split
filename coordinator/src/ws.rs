use crate::protocol::{ClientMsg, Quadrant, ServerMsg, WallState};
use crate::state::{ActorMsg, StateHandle};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use uuid::Uuid;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<StateHandle>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

#[derive(Default)]
struct ConnContext {
    /// Set when this connection's Announce arrives. Lets us recompute
    /// host_quadrants whenever the layout changes.
    host_id: Option<String>,
    /// Cached set of quadrants currently routed to this connection's host.
    host_quadrants: HashSet<Quadrant>,
}

fn quadrants_for_host(state: &WallState, host_id: &str) -> HashSet<Quadrant> {
    state
        .layout
        .iter()
        .filter(|(_, a)| a.host_id == host_id)
        .map(|(q, _)| *q)
        .collect()
}

async fn handle_socket(socket: WebSocket, state: Arc<StateHandle>) {
    let client_id = Uuid::new_v4().to_string();
    info!(client_id, "websocket connected");

    let (mut sender, mut receiver) = socket.split();

    if let Err(e) = send_json(
        &mut sender,
        &ServerMsg::Welcome {
            client_id: client_id.clone(),
        },
    )
    .await
    {
        warn!(?e, "failed to send welcome");
        return;
    }

    let initial = state.state_rx.borrow().clone();
    if let Err(e) = send_json(&mut sender, &ServerMsg::State(initial)).await {
        warn!(?e, "failed to send initial state");
        return;
    }

    let mut state_rx = state.state_rx.clone();
    let mut correction_rx = state.correction_tx.subscribe();
    let cmd_tx = state.cmd_tx.clone();

    let ctx = Arc::new(RwLock::new(ConnContext::default()));
    let ctx_send = ctx.clone();

    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = state_rx.changed() => {
                    if changed.is_err() { break; }
                    let snapshot = state_rx.borrow().clone();
                    // Refresh cached quadrant set on every state change.
                    {
                        let mut c = ctx_send.write().await;
                        if let Some(host_id) = c.host_id.clone() {
                            c.host_quadrants = quadrants_for_host(&snapshot, &host_id);
                        }
                    }
                    if send_json(&mut sender, &ServerMsg::State(snapshot)).await.is_err() {
                        break;
                    }
                }
                correction = correction_rx.recv() => {
                    let Ok(corr) = correction else { continue };
                    let interested = ctx_send.read().await.host_quadrants.contains(&corr.quadrant);
                    if interested {
                        let msg = ServerMsg::Correct { quadrant: corr.quadrant, to: corr.to };
                        if send_json(&mut sender, &msg).await.is_err() { break; }
                    }
                }
            }
        }
    });

    let cmd_tx_recv = cmd_tx.clone();
    let client_id_recv = client_id.clone();
    let ctx_recv = ctx.clone();
    let state_rx_recv = state.state_rx.clone();

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(txt) => {
                    let parsed: Result<ClientMsg, _> = serde_json::from_str(&txt);
                    match parsed {
                        Ok(ClientMsg::Hello { role, hostname }) => {
                            info!(?role, hostname, "client identified");
                        }
                        Ok(ClientMsg::Announce {
                            host_id,
                            hostname,
                            platform,
                            displays,
                        }) => {
                            let host = crate::protocol::HostInfo {
                                host_id: host_id.clone(),
                                hostname,
                                platform,
                                displays,
                            };
                            {
                                let mut c = ctx_recv.write().await;
                                c.host_id = Some(host_id.clone());
                                c.host_quadrants =
                                    quadrants_for_host(&state_rx_recv.borrow(), &host_id);
                            }
                            let _ = cmd_tx_recv
                                .send(ActorMsg::Announce {
                                    conn_id: client_id_recv.clone(),
                                    host,
                                })
                                .await;
                        }
                        Ok(ClientMsg::Heartbeat {
                            quadrant,
                            current_time,
                            paused,
                            ready_state,
                            source_dimensions,
                        }) => {
                            let _ = cmd_tx_recv
                                .send(ActorMsg::Heartbeat {
                                    quadrant,
                                    current_time,
                                    paused,
                                    ready_state,
                                    source_dimensions,
                                })
                                .await;
                        }
                        Ok(ClientMsg::Command { command }) => {
                            let _ = cmd_tx_recv.send(ActorMsg::Command(command)).await;
                        }
                        Err(e) => warn!(?e, raw = %txt, "failed to parse client message"),
                    }
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => {
                    debug!("ignoring non-text message");
                }
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    let _ = cmd_tx
        .send(ActorMsg::Disconnected {
            conn_id: client_id.clone(),
        })
        .await;
    info!(client_id, "websocket disconnected");
}

async fn send_json<S>(sender: &mut S, msg: &ServerMsg) -> anyhow::Result<()>
where
    S: SinkExt<Message, Error = axum::Error> + Unpin,
{
    let txt = serde_json::to_string(msg)?;
    sender
        .send(Message::Text(txt.into()))
        .await
        .map_err(|e| anyhow::anyhow!(e))
}
