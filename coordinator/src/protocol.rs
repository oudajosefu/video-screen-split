use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
#[serde(rename_all = "kebab-case")]
pub enum Quadrant {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
#[serde(rename_all = "kebab-case")]
pub enum ClientRole {
    Display,
    Controller,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
#[serde(rename_all = "kebab-case")]
pub enum FitMode {
    Letterbox,
    Fill,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

/// One physical display attached to a host. `id` is opaque (Electron's
/// `display.id` stringified — large enough on macOS that we keep it as a
/// string to avoid TS bigint headaches).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
pub struct DisplayInfo {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub bounds_x: i32,
    pub bounds_y: i32,
    pub primary: bool,
    pub internal: bool,
}

/// Snapshot of one connected display-app and what monitors it can drive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
pub struct HostInfo {
    pub host_id: String,
    pub hostname: String,
    pub platform: String,
    pub displays: Vec<DisplayInfo>,
}

/// Which (host, display) pair drives a given quadrant. None = unassigned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
pub struct QuadrantAssignment {
    pub host_id: String,
    pub display_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
pub struct WallState {
    pub source_url: Option<String>,
    pub paused: bool,
    pub current_time: f64,
    pub seek_epoch: u32,
    pub audio_owner: Quadrant,
    pub fit_mode: FitMode,
    pub source_dimensions: Option<Dimensions>,
    /// Currently-connected hosts, keyed by host_id. Live (not persisted).
    pub hosts: BTreeMap<String, HostInfo>,
    /// Layout: which (host, display) drives each quadrant.
    pub layout: BTreeMap<Quadrant, QuadrantAssignment>,
}

impl Default for WallState {
    fn default() -> Self {
        Self {
            source_url: None,
            paused: true,
            current_time: 0.0,
            seek_epoch: 0,
            audio_owner: Quadrant::TopLeft,
            fit_mode: FitMode::Fill,
            source_dimensions: None,
            hosts: BTreeMap::new(),
            layout: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMsg {
    /// Identify this connection. Sent once after connect.
    Hello {
        role: ClientRole,
        hostname: String,
    },
    /// Display app self-describes its capabilities. Sent after Hello.
    Announce {
        host_id: String,
        hostname: String,
        platform: String,
        displays: Vec<DisplayInfo>,
    },
    /// Display windows send this every ~250ms. quadrant identifies the window.
    Heartbeat {
        quadrant: Quadrant,
        current_time: f64,
        paused: bool,
        ready_state: u8,
        source_dimensions: Option<Dimensions>,
    },
    /// Controller-initiated state mutations.
    Command {
        command: WallCommand,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum WallCommand {
    SetSource { url: String },
    Play,
    Pause,
    Seek { to: f64 },
    SetAudioOwner { quadrant: Quadrant },
    SetFitMode { mode: FitMode },
    /// Assign a (host, display) pair to a quadrant. None unassigns.
    AssignQuadrant {
        quadrant: Quadrant,
        assignment: Option<QuadrantAssignment>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../display-app/src/generated/")]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMsg {
    State(WallState),
    Correct { quadrant: Quadrant, to: f64 },
    Welcome { client_id: String },
}
