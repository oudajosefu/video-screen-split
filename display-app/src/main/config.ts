import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";

export interface AppConfig {
  /** Stable per-machine identifier so the coordinator can re-associate this
   * host across restarts. Generated on first run. */
  hostId: string;
  /** Override coordinator URL. Falls back to mDNS when absent. */
  coordinatorUrl?: string;
}

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

export function loadOrInitConfig(): AppConfig {
  const p = configPath();
  let existingCoordUrl: string | undefined;
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<AppConfig>;
      existingCoordUrl = parsed.coordinatorUrl;
      if (parsed.hostId) {
        return { hostId: parsed.hostId, coordinatorUrl: parsed.coordinatorUrl };
      }
    } catch (e) {
      console.warn("config parse failed, regenerating:", e);
    }
  }
  // Either no config or a pre-refactor config without hostId: write a fresh
  // one but preserve coordinatorUrl if the old one had it set.
  const fresh: AppConfig = { hostId: randomUUID(), coordinatorUrl: existingCoordUrl };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(fresh, null, 2));
  console.log("wrote fresh config at", p);
  return fresh;
}

export function persistCoordinatorUrl(url: string): void {
  const p = configPath();
  const current = loadOrInitConfig();
  fs.writeFileSync(p, JSON.stringify({ ...current, coordinatorUrl: url }, null, 2));
}
