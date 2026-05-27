# video-screen-split

Display a single browser video across a 2x2 monitor wall driven by two separate computers (Mac Studio drives the top row, Windows laptop drives the bottom row).

Each monitor independently loads the source video and crops to its quadrant via CSS. A Rust coordinator keeps the four playheads synchronized over WebSocket. DRM-protected services (Netflix, Disney+, HBO Max) work because each window does its own Widevine playback — no screen capture is involved.

## Components

| Path | Purpose | Stack |
|---|---|---|
| `coordinator/` | WebSocket sync hub, embedded controller UI, mDNS discovery | Rust (axum, tokio) |
| `controller-ui/` | Web UI for source URL + transport controls | React + Vite |
| `display-app/` | One Electron app per machine; spawns one fullscreen window per attached monitor | Electron (castLabs Widevine build) |

## Build

```sh
# 1. Install everything
npm install

# 2. Generate the wire-protocol TypeScript bindings from the Rust source of truth
cargo test -p coordinator

# 3. Build the UI (outputs static files into controller-ui/dist/)
npm run build:ui

# 4. Build the coordinator binary (embeds the UI dist via rust-embed)
npm run build:coordinator

# 5. Build the display-app
npm run build:display-app
```

## Switch to castLabs Electron for DRM playback

The display-app uses stock Electron by default — fine for YouTube, Jellyfin, Twitch, and local files. To play Netflix / Disney+ / HBO Max / Amazon Prime you need a Widevine-licensed Chromium build:

```sh
# Install the castLabs fork as your Electron dependency
npm --workspace=display-app install --save-dev \
  electron@https://github.com/castlabs/electron-releases#electron-v33.2.1+wvcus

# One-time: register a free account with castLabs (for VMP signing)
pip3 install castlabs-evs
python3 -m castlabs_evs.account signup

# Repackage; the afterSign hook signs the bundle so Widevine trusts it
npm --workspace=display-app run package
```

For dev builds without DRM, set `SKIP_VMP_SIGN=1` to bypass the signing step.

## Run

```sh
# On whichever machine you designate as the coordinator host (typically the Mac):
./target/release/coordinator

# On each machine (Mac + Windows):
npm --workspace=display-app run start
```

Open `http://<coordinator-host>:8787/` from any device on the LAN to control playback. The display app finds the coordinator via mDNS automatically.

## Configure which monitors each machine drives

On first run, the display app writes a default config to its `userData` directory. Edit it to match your physical layout:

- **macOS:** `~/Library/Application Support/video-screen-split/config.json`
- **Windows:** `%APPDATA%\video-screen-split\config.json`

```json
{
  "mappings": [
    { "quadrant": "top-left",  "displayId": 69733504 },
    { "quadrant": "top-right", "displayId": 69733505 }
  ]
}
```

Get the `displayId` values from Electron's `screen.getAllDisplays()` — log them on first run or open DevTools on one of the windows. Set `coordinatorUrl` to bypass mDNS (e.g. `"ws://10.0.0.5:8787/ws"`).

## Why Electron and not Tauri

See [the plan file](../.claude/plans/i-have-a-2x2-luminous-crescent.md#why-not-tauri) for the full analysis. Short version: WebView2 doesn't expose Widevine to embedders, WKWebView doesn't support EME at all, so the only cross-platform path to DRM playback is a Widevine-licensed Chromium build — which is what the castLabs Electron release provides.

## Concurrent stream limits

Each window logs into the streaming service independently using its own Electron session partition, so each window counts as one device.

| Service | Plan needed for 2x2 |
|---|---|
| Netflix | Premium (4 streams) |
| Disney+ | Any |
| HBO Max | Ultimate (4 streams) |
| Prime Video | Not supported (limit 2) |
| Hulu | Not supported (limit 2) |
| YouTube / Twitch / Jellyfin / local | Any |
