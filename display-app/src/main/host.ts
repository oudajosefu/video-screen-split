import { screen } from "electron";
import os from "node:os";
import type { DisplayInfo } from "@proto/DisplayInfo";

export function enumerateDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    label: d.label || `Display ${d.id}`,
    width: d.size.width,
    height: d.size.height,
    bounds_x: d.bounds.x,
    bounds_y: d.bounds.y,
    primary: d.id === primary.id,
    internal: d.internal,
  }));
}

export function platformLabel(): string {
  switch (os.platform()) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return os.platform();
  }
}
