import WebSocket from "ws";
import { EventEmitter } from "node:events";
import os from "node:os";
import type { ClientMsg } from "@proto/ClientMsg";
import type { ServerMsg } from "@proto/ServerMsg";
import type { WallState } from "@proto/WallState";
import type { DisplayInfo } from "@proto/DisplayInfo";
import type { Quadrant } from "@proto/Quadrant";
import type { Dimensions } from "@proto/Dimensions";
import type { WallCommand } from "@proto/WallCommand";

const RECONNECT_MS = 2000;

export interface AnnounceArgs {
  hostId: string;
  displays: DisplayInfo[];
  platform: string;
}

export class CoordinatorClient extends EventEmitter {
  private sock: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastAnnounce: AnnounceArgs | null = null;

  constructor(private readonly url: string) {
    super();
  }

  start(): void {
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.close();
  }

  announce(args: AnnounceArgs): void {
    this.lastAnnounce = args;
    this.sendAnnounce();
  }

  sendCommand(command: WallCommand): void {
    this.send({ type: "command", command });
  }

  sendHeartbeat(
    quadrant: Quadrant,
    currentTime: number,
    paused: boolean,
    readyState: number,
    sourceDimensions: Dimensions | null,
  ): void {
    this.send({
      type: "heartbeat",
      quadrant,
      current_time: currentTime,
      paused,
      ready_state: readyState,
      source_dimensions: sourceDimensions,
    });
  }

  private sendAnnounce(): void {
    if (!this.lastAnnounce) return;
    this.send({
      type: "announce",
      host_id: this.lastAnnounce.hostId,
      hostname: os.hostname(),
      platform: this.lastAnnounce.platform,
      displays: this.lastAnnounce.displays,
    });
  }

  private send(msg: ClientMsg): void {
    if (this.sock?.readyState === WebSocket.OPEN) {
      this.sock.send(JSON.stringify(msg));
    }
  }

  private connect(): void {
    if (this.closed) return;
    const sock = new WebSocket(this.url);
    this.sock = sock;

    sock.on("open", () => {
      this.send({ type: "hello", role: "display", hostname: os.hostname() });
      this.sendAnnounce();
      this.emit("connected");
    });

    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ServerMsg;
        switch (msg.type) {
          case "state": {
            const { type: _t, ...rest } = msg as { type: "state" } & WallState;
            this.emit("state", rest as WallState);
            break;
          }
          case "correct":
            this.emit("correct", msg.quadrant, msg.to);
            break;
          case "welcome":
            break;
        }
      } catch (e) {
        console.warn("malformed server message:", e);
      }
    });

    sock.on("close", () => {
      this.emit("disconnected");
      this.scheduleReconnect();
    });
    sock.on("error", (e) => {
      console.warn("ws error:", e.message);
      sock.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
  }
}
