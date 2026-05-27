import { app, ipcMain, screen, BrowserWindow } from "electron";
import path from "node:path";
import { loadOrInitConfig, persistCoordinatorUrl } from "./config";
import { spawnQuadrantWindow } from "./displays";
import { discoverCoordinator } from "./discovery";
import { CoordinatorClient } from "./sync";
import { enumerateDisplays, platformLabel } from "./host";
import { promptForCoordinatorUrl } from "./setup-prompt";
import type { Dimensions } from "@proto/Dimensions";
import type { WallState } from "@proto/WallState";
import type { Quadrant } from "@proto/Quadrant";

app.setName("video-screen-split");

const PRELOAD = path.join(__dirname, "..", "preload", "index.js");

interface OpenWindow {
  window: BrowserWindow;
  displayId: string;
  loadedUrl: string | null;
}

/**
 * Owns the set of open quadrant windows on this machine and keeps them in
 * sync with the coordinator's layout + source URL state.
 */
class WindowManager {
  private windows = new Map<Quadrant, OpenWindow>();
  private latestState: WallState | null = null;

  constructor(private readonly hostId: string) {}

  applyState(state: WallState): void {
    this.latestState = state;
    this.reconcileWindows(state);
    this.reconcileNavigation(state);
    // Forward to already-loaded pages so they can apply play/pause/seek/etc.
    // Pages still navigating will re-receive state via the did-finish-load
    // handler set up in openOrReuse().
    for (const { window, loadedUrl } of this.windows.values()) {
      if (window.isDestroyed()) continue;
      if (loadedUrl && loadedUrl === state.source_url) {
        window.webContents.send("display:state", state);
      }
    }
  }

  forwardTo(quadrant: Quadrant, channel: string, payload: unknown): void {
    const entry = this.windows.get(quadrant);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.webContents.send(channel, payload);
    }
  }

  isOwnedBy(webContents: Electron.WebContents): Quadrant | null {
    for (const [quadrant, { window }] of this.windows) {
      if (window.webContents === webContents) return quadrant;
    }
    return null;
  }

  closeAll(): void {
    for (const { window } of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }

  private reconcileWindows(state: WallState): void {
    const desired = this.desiredForThisHost(state);

    for (const [quadrant, open] of this.windows) {
      const wantedDisplay = desired.get(quadrant);
      if (!wantedDisplay) {
        console.log(`closing window for ${quadrant} (no longer assigned)`);
        open.window.destroy();
        this.windows.delete(quadrant);
      } else if (wantedDisplay !== open.displayId) {
        console.log(
          `closing window for ${quadrant} (display changed ${open.displayId}→${wantedDisplay})`,
        );
        open.window.destroy();
        this.windows.delete(quadrant);
      }
    }

    for (const [quadrant, displayId] of desired) {
      if (this.windows.has(quadrant)) continue;
      console.log(`opening window for ${quadrant} on display ${displayId}`);
      const window = spawnQuadrantWindow(quadrant, displayId, PRELOAD);
      const entry: OpenWindow = { window, displayId, loadedUrl: null };
      this.windows.set(quadrant, entry);

      window.webContents.on("did-finish-load", () => {
        if (!this.latestState) return;
        // After every navigation, re-deliver the latest state so the preload
        // (which just freshly initialized in the new page) can apply crop,
        // play/pause, seek, and audio routing.
        window.webContents.send("display:state", this.latestState);
      });
    }
  }

  private reconcileNavigation(state: WallState): void {
    const target = state.source_url ?? "about:blank";
    for (const entry of this.windows.values()) {
      if (entry.window.isDestroyed()) continue;
      if (entry.loadedUrl === target) continue;
      console.log(`navigating window → ${target}`);
      entry.loadedUrl = target;
      entry.window.loadURL(target).catch((e) => {
        console.warn(`navigation failed: ${e?.message ?? e}`);
        entry.loadedUrl = null;
      });
    }
  }

  private desiredForThisHost(state: WallState): Map<Quadrant, string> {
    const result = new Map<Quadrant, string>();
    const layout = state.layout ?? {};
    for (const [quadrant, assignment] of Object.entries(layout)) {
      if (!assignment) continue;
      if (assignment.host_id !== this.hostId) continue;
      result.set(quadrant as Quadrant, assignment.display_id);
    }
    return result;
  }
}

async function resolveCoordinatorUrl(configured?: string): Promise<string> {
  if (configured) {
    console.log("using configured coordinator:", configured);
    return configured;
  }
  console.log("discovering coordinator via mDNS...");
  try {
    const { host, port } = await discoverCoordinator(5_000);
    const url = `ws://${host}:${port}/ws`;
    console.log("found coordinator:", url);
    persistCoordinatorUrl(url);
    return url;
  } catch (e) {
    console.log("mDNS failed, asking user for coordinator URL");
    const url = await promptForCoordinatorUrl("ws://localhost:8787/ws");
    persistCoordinatorUrl(url);
    return url;
  }
}

async function main(): Promise<void> {
  await app.whenReady();

  const cfg = loadOrInitConfig();
  console.log("host_id:", cfg.hostId);

  const displays = enumerateDisplays();
  console.log("available displays:", JSON.stringify(displays, null, 2));

  const coordUrl = await resolveCoordinatorUrl(cfg.coordinatorUrl);

  const client = new CoordinatorClient(coordUrl);
  const manager = new WindowManager(cfg.hostId);

  client.on("state", (state: WallState) => {
    manager.applyState(state);
  });

  client.on("correct", (quadrant: Quadrant, to: number) => {
    manager.forwardTo(quadrant, "display:correct", to);
  });

  client.on("connected", () => console.log("coordinator: connected"));
  client.on("disconnected", () => console.log("coordinator: disconnected"));

  ipcMain.on(
    "display:heartbeat",
    (
      event,
      payload: {
        currentTime: number;
        paused: boolean;
        readyState: number;
        sourceDimensions: Dimensions | null;
      },
    ) => {
      const quadrant = manager.isOwnedBy(event.sender);
      if (!quadrant) return;
      client.sendHeartbeat(
        quadrant,
        payload.currentTime,
        payload.paused,
        payload.readyState,
        payload.sourceDimensions,
      );
    },
  );

  // Re-announce when monitors are plugged/unplugged.
  const reannounce = () => {
    client.announce({
      hostId: cfg.hostId,
      displays: enumerateDisplays(),
      platform: platformLabel(),
    });
  };
  screen.on("display-added", reannounce);
  screen.on("display-removed", reannounce);
  screen.on("display-metrics-changed", reannounce);

  client.announce({
    hostId: cfg.hostId,
    displays,
    platform: platformLabel(),
  });
  client.start();

  app.on("window-all-closed", () => {
    // Don't quit when windows close — the coordinator might re-assign us.
    // The user explicitly quits with Cmd+Q (macOS) or by closing all dock
    // instances; the activate handler keeps us alive otherwise.
  });

  app.on("before-quit", () => {
    manager.closeAll();
    client.close();
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  app.exit(1);
});
