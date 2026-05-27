import { useEffect, useRef, useState, useCallback } from "react";
import type { WallState } from "@proto/WallState";
import type { ServerMsg } from "@proto/ServerMsg";
import type { ClientMsg } from "@proto/ClientMsg";
import type { WallCommand } from "@proto/WallCommand";

export type Status = "connecting" | "open" | "closed";

const RECONNECT_MS = 1500;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function useWall() {
  const [status, setStatus] = useState<Status>("connecting");
  const [state, setState] = useState<WallState | null>(null);
  const sockRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      setStatus("connecting");
      const sock = new WebSocket(wsUrl());
      sockRef.current = sock;

      sock.onopen = () => {
        setStatus("open");
        const hello: ClientMsg = {
          type: "hello",
          role: "controller",
          hostname: navigator.userAgent.slice(0, 32),
        };
        sock.send(JSON.stringify(hello));
      };

      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerMsg;
          if (msg.type === "state") {
            // ServerMsg::State flattens WallState fields alongside `type`.
            const { type: _t, ...rest } = msg as { type: "state" } & WallState;
            setState(rest as WallState);
          }
        } catch {
          // ignore malformed
        }
      };

      sock.onclose = () => {
        if (cancelled) return;
        setStatus("closed");
        reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
      };
      sock.onerror = () => sock.close();
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      sockRef.current?.close();
    };
  }, []);

  const send = useCallback((command: WallCommand) => {
    const sock = sockRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg = { type: "command", command };
    sock.send(JSON.stringify(msg));
  }, []);

  return { status, state, send };
}
