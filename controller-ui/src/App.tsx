import { useState, useEffect, useMemo } from "react";
import { useWall } from "./useWall";
import type { Quadrant } from "@proto/Quadrant";
import type { FitMode } from "@proto/FitMode";
import type { QuadrantAssignment } from "@proto/QuadrantAssignment";
import type { WallState } from "@proto/WallState";

const QUADRANTS: { value: Quadrant; label: string }[] = [
  { value: "top-left", label: "Top-Left" },
  { value: "top-right", label: "Top-Right" },
  { value: "bottom-left", label: "Bottom-Left" },
  { value: "bottom-right", label: "Bottom-Right" },
];

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;
}

interface DisplayOption {
  hostId: string;
  hostLabel: string;
  displayId: string;
  displayLabel: string;
}

function flattenDisplayOptions(state: WallState | null): DisplayOption[] {
  if (!state) return [];
  const out: DisplayOption[] = [];
  for (const [hostId, host] of Object.entries(state.hosts ?? {})) {
    if (!host) continue;
    const hostLabel = `${host.hostname} (${host.platform})`;
    for (const d of host.displays) {
      const sizeLabel = `${d.width}×${d.height}`;
      const primaryTag = d.primary ? " · primary" : "";
      out.push({
        hostId,
        hostLabel,
        displayId: d.id,
        displayLabel: `${d.label} · ${sizeLabel}${primaryTag}`,
      });
    }
  }
  return out;
}

function optionKey(o: DisplayOption): string {
  return `${o.hostId}::${o.displayId}`;
}

function parseOptionKey(k: string): { hostId: string; displayId: string } | null {
  if (k === "") return null;
  const [hostId, displayId] = k.split("::");
  if (!hostId || !displayId) return null;
  return { hostId, displayId };
}

function assignmentToKey(a: QuadrantAssignment | null | undefined): string {
  if (!a) return "";
  return `${a.host_id}::${a.display_id}`;
}

export function App() {
  const { status, state, send } = useWall();
  const [urlInput, setUrlInput] = useState("");
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  useEffect(() => {
    if (state?.source_url && urlInput === "") setUrlInput(state.source_url);
  }, [state?.source_url]);

  const options = useMemo(() => flattenDisplayOptions(state), [state]);
  const hostsConnected = Object.keys(state?.hosts ?? {}).length;

  const onLoad = () => {
    if (!urlInput.trim()) return;
    send({ type: "set-source", url: urlInput.trim() });
  };

  const onPlayPause = () => {
    if (!state) return;
    send(state.paused ? { type: "play" } : { type: "pause" });
  };

  const onSeek = (to: number) => {
    send({ type: "seek", to });
    setScrubbing(null);
  };

  const setAudioOwner = (quadrant: Quadrant) =>
    send({ type: "set-audio-owner", quadrant });

  const setFit = (mode: FitMode) => send({ type: "set-fit-mode", mode });

  const setQuadrant = (quadrant: Quadrant, key: string) => {
    const parsed = parseOptionKey(key);
    send({
      type: "assign-quadrant",
      quadrant,
      assignment: parsed
        ? { host_id: parsed.hostId, display_id: parsed.displayId }
        : null,
    });
  };

  const displayedTime = scrubbing ?? state?.current_time ?? 0;
  const max = Math.max(displayedTime, 600);

  return (
    <>
      <header>
        <h1>video-screen-split</h1>
        <span
          className={`conn ${status === "open" ? "ok" : status === "closed" ? "err" : ""}`}
        >
          {status}
        </span>
      </header>

      <section>
        <h2>Source</h2>
        <div className="row">
          <input
            type="url"
            placeholder="https://..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onLoad()}
          />
          <button className="primary" onClick={onLoad}>
            Load
          </button>
        </div>
      </section>

      <section>
        <h2>Transport</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <button onClick={onPlayPause} disabled={!state?.source_url}>
            {state?.paused ? "▶ Play" : "❚❚ Pause"}
          </button>
          <span className="time">{fmtTime(displayedTime)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={0.5}
          value={displayedTime}
          onChange={(e) => setScrubbing(Number(e.target.value))}
          onMouseUp={(e) => onSeek(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) =>
            onSeek(Number((e.target as HTMLInputElement).value))
          }
          disabled={!state?.source_url}
        />
      </section>

      <section>
        <h2>Layout</h2>
        {hostsConnected === 0 ? (
          <p className="muted">
            No display hosts connected. Start the display app on one of your
            machines.
          </p>
        ) : (
          <div className="layout-grid">
            {QUADRANTS.map((q) => {
              const current = state?.layout?.[q.value];
              const currentKey = assignmentToKey(current);
              const knownInOptions = options.some(
                (o) => optionKey(o) === currentKey,
              );
              return (
                <label key={q.value} className="layout-row">
                  <span className="layout-quadrant">{q.label}</span>
                  <select
                    value={currentKey}
                    onChange={(e) => setQuadrant(q.value, e.target.value)}
                  >
                    <option value="">— Unassigned —</option>
                    {options.map((o) => (
                      <option key={optionKey(o)} value={optionKey(o)}>
                        {o.hostLabel} → {o.displayLabel}
                      </option>
                    ))}
                    {currentKey && !knownInOptions && (
                      <option value={currentKey} disabled>
                        (assigned host offline)
                      </option>
                    )}
                  </select>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2>Audio source</h2>
        <div className="quad-grid">
          {QUADRANTS.map((q) => (
            <button
              key={q.value}
              className={state?.audio_owner === q.value ? "selected" : ""}
              onClick={() => setAudioOwner(q.value)}
            >
              {q.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Fit mode</h2>
        <div className="fit-toggle">
          <button
            className={state?.fit_mode === "fill" ? "selected" : ""}
            onClick={() => setFit("fill")}
          >
            Fill (crop edges)
          </button>
          <button
            className={state?.fit_mode === "letterbox" ? "selected" : ""}
            onClick={() => setFit("letterbox")}
          >
            Letterbox (show all)
          </button>
        </div>
      </section>

      {state?.source_dimensions && (
        <section>
          <h2>Source</h2>
          <div className="time">
            {state.source_dimensions.width} × {state.source_dimensions.height}
          </div>
        </section>
      )}

      <section>
        <h2>Connected hosts</h2>
        {hostsConnected === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="host-list">
            {Object.entries(state?.hosts ?? {}).map(([id, host]) =>
              host ? (
                <li key={id}>
                  <strong>{host.hostname}</strong>{" "}
                  <span className="muted">({host.platform})</span>
                  <span className="muted"> — {host.displays.length} displays</span>
                </li>
              ) : null,
            )}
          </ul>
        )}
      </section>
    </>
  );
}
