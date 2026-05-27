import { BrowserWindow, screen, session } from "electron";
import os from "node:os";
import type { Quadrant } from "@proto/Quadrant";

/**
 * Each quadrant gets its own persistent session partition so streaming
 * services see independent device logins.
 */
function sessionForQuadrant(quadrant: Quadrant): Electron.Session {
  return session.fromPartition(`persist:${quadrant}`);
}

export function spawnQuadrantWindow(
  quadrant: Quadrant,
  displayId: string,
  preloadPath: string,
): BrowserWindow {
  const displays = screen.getAllDisplays();
  const target =
    displays.find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: false,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: sessionForQuadrant(quadrant),
      additionalArguments: [`--quadrant=${quadrant}`],
    },
  });

  win.setBounds(target.bounds);
  if (os.platform() === "darwin") {
    win.setSimpleFullScreen(true);
  } else {
    win.setFullScreen(true);
  }

  win.loadURL("about:blank");
  return win;
}
