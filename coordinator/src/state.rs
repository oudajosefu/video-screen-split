use crate::protocol::{Dimensions, HostInfo, Quadrant, WallCommand, WallState};
use std::collections::HashMap;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{debug, info};

/// Followers correct themselves when drift exceeds this many seconds.
const DRIFT_THRESHOLD_SECS: f64 = 0.1;

#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct QuadrantStatus {
    current_time: f64,
    paused: bool,
    ready_state: u8,
}

pub struct StateActor {
    state_tx: watch::Sender<WallState>,
    cmd_rx: mpsc::Receiver<ActorMsg>,
    statuses: HashMap<Quadrant, QuadrantStatus>,
    /// connection_id -> host_id, so we can clean up hosts when a conn drops.
    conn_to_host: HashMap<String, String>,
    correction_tx: broadcast::Sender<Correction>,
}

pub enum ActorMsg {
    Command(WallCommand),
    Heartbeat {
        quadrant: Quadrant,
        current_time: f64,
        paused: bool,
        ready_state: u8,
        source_dimensions: Option<Dimensions>,
    },
    Announce {
        conn_id: String,
        host: HostInfo,
    },
    Disconnected {
        conn_id: String,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct Correction {
    pub quadrant: Quadrant,
    pub to: f64,
}

#[derive(Clone)]
pub struct StateHandle {
    pub cmd_tx: mpsc::Sender<ActorMsg>,
    pub state_rx: watch::Receiver<WallState>,
    pub correction_tx: broadcast::Sender<Correction>,
}

impl StateActor {
    pub fn spawn() -> StateHandle {
        let (state_tx, state_rx) = watch::channel(WallState::default());
        let (cmd_tx, cmd_rx) = mpsc::channel(128);
        let (correction_tx, _) = broadcast::channel(64);

        let actor = StateActor {
            state_tx,
            cmd_rx,
            statuses: HashMap::new(),
            conn_to_host: HashMap::new(),
            correction_tx: correction_tx.clone(),
        };
        tokio::spawn(actor.run());
        StateHandle {
            cmd_tx,
            state_rx,
            correction_tx,
        }
    }

    async fn run(mut self) {
        info!("state actor started");
        while let Some(msg) = self.cmd_rx.recv().await {
            match msg {
                ActorMsg::Command(cmd) => self.apply_command(cmd),
                ActorMsg::Heartbeat {
                    quadrant,
                    current_time,
                    paused,
                    ready_state,
                    source_dimensions,
                } => self.handle_heartbeat(
                    quadrant,
                    current_time,
                    paused,
                    ready_state,
                    source_dimensions,
                ),
                ActorMsg::Announce { conn_id, host } => self.handle_announce(conn_id, host),
                ActorMsg::Disconnected { conn_id } => self.handle_disconnected(conn_id),
            }
        }
    }

    fn apply_command(&mut self, cmd: WallCommand) {
        let mut state = self.state_tx.borrow().clone();
        match cmd {
            WallCommand::SetSource { url } => {
                info!(url, "setting source");
                state.source_url = Some(url);
                state.current_time = 0.0;
                state.seek_epoch = state.seek_epoch.wrapping_add(1);
                state.paused = true;
                state.source_dimensions = None;
            }
            WallCommand::Play => state.paused = false,
            WallCommand::Pause => state.paused = true,
            WallCommand::Seek { to } => {
                state.current_time = to;
                state.seek_epoch = state.seek_epoch.wrapping_add(1);
            }
            WallCommand::SetAudioOwner { quadrant } => state.audio_owner = quadrant,
            WallCommand::SetFitMode { mode } => state.fit_mode = mode,
            WallCommand::AssignQuadrant {
                quadrant,
                assignment,
            } => match assignment {
                Some(a) => {
                    info!(?quadrant, host = %a.host_id, display = a.display_id, "assigning quadrant");
                    state.layout.insert(quadrant, a);
                }
                None => {
                    info!(?quadrant, "unassigning quadrant");
                    state.layout.remove(&quadrant);
                }
            },
        }
        let _ = self.state_tx.send(state);
    }

    fn handle_announce(&mut self, conn_id: String, host: HostInfo) {
        info!(conn_id, host_id = %host.host_id, hostname = %host.hostname, "host announced");
        self.conn_to_host.insert(conn_id, host.host_id.clone());
        let mut state = self.state_tx.borrow().clone();
        state.hosts.insert(host.host_id.clone(), host);
        let _ = self.state_tx.send(state);
    }

    fn handle_disconnected(&mut self, conn_id: String) {
        if let Some(host_id) = self.conn_to_host.remove(&conn_id) {
            // Only remove the host if no other connection claims the same host_id.
            let still_present = self.conn_to_host.values().any(|h| h == &host_id);
            if !still_present {
                info!(host_id, "host disconnected, removing");
                let mut state = self.state_tx.borrow().clone();
                state.hosts.remove(&host_id);
                let _ = self.state_tx.send(state);
            }
        }
    }

    fn handle_heartbeat(
        &mut self,
        quadrant: Quadrant,
        current_time: f64,
        paused: bool,
        ready_state: u8,
        source_dimensions: Option<Dimensions>,
    ) {
        self.statuses.insert(
            quadrant,
            QuadrantStatus {
                current_time,
                paused,
                ready_state,
            },
        );

        if let Some(dims) = source_dimensions {
            let state = self.state_tx.borrow();
            if state.source_dimensions != Some(dims) {
                let mut new_state = state.clone();
                drop(state);
                new_state.source_dimensions = Some(dims);
                let _ = self.state_tx.send(new_state);
            }
        }

        let leader_quadrant = self.state_tx.borrow().audio_owner;
        let leader_time = self
            .statuses
            .get(&leader_quadrant)
            .map(|s| s.current_time)
            .unwrap_or_else(|| self.state_tx.borrow().current_time);

        if quadrant == leader_quadrant {
            let mut new_state = self.state_tx.borrow().clone();
            new_state.current_time = current_time;
            let _ = self.state_tx.send(new_state);
            return;
        }

        let drift = (current_time - leader_time).abs();
        if drift > DRIFT_THRESHOLD_SECS {
            debug!(
                ?quadrant,
                drift, leader_time, "drift exceeded threshold, correcting"
            );
            let _ = self.correction_tx.send(Correction {
                quadrant,
                to: leader_time,
            });
        }
    }
}
