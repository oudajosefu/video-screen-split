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
}

/**
 * Owns the set of open quadrant windows on this machine and keeps them in
 * sync with the coordinator's layout state.
 */
class WindowManager {
  private windows = new Map<Quadrant, OpenWindow>();

  constructor(private readonly hostId: string) {}

  reconcile(state: WallState): void {
    const desired = this.desiredForThisHost(state);

    // Close windows no longer assigned to this host.
    for (const [quadrant, open] of this.windows) {
      const stillWanted = desired.get(quadrant);
      if (!stillWanted) {
        console.log(`closing window for ${quadrant} (no longer assigned)`);
        open.window.destroy();
        this.windows.delete(quadrant);
      } else if (stillWanted !== open.displayId) {
        // Reassigned to a different display: close so we re-open below.
        console.log(
          `closing window for ${quadrant} (display changed ${open.displayId}→${stillWanted})`,
        );
        open.window.destroy();
        this.windows.delete(quadrant);
      }
    }

    // Open windows for newly assigned quadrants.
    for (const [quadrant, displayId] of desired) {
      if (this.windows.has(quadrant)) continue;
      console.log(`opening window for ${quadrant} on display ${displayId}`);
      const window = spawnQuadrantWindow(quadrant, displayId, PRELOAD);
      this.windows.set(quadrant, { window, displayId });
    }
  }

  forwardToAll(channel: string, payload: unknown): void {
    for (const { window } of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
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
    manager.reconcile(state);
    manager.forwardToAll("display:state", state);
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
