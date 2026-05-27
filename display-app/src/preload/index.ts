import { ipcRenderer } from "electron";
import type { Quadrant } from "@proto/Quadrant";
import type { WallState } from "@proto/WallState";
import type { Dimensions } from "@proto/Dimensions";
import type { FitMode } from "@proto/FitMode";
import type { WallCommand } from "@proto/WallCommand";

const QUADRANT: Quadrant = readQuadrant();
const HEARTBEAT_INTERVAL_MS = 250;
const CORRECTION_TOLERANCE_S = 0.05;
const OVERLAY_HIDE_AFTER_MS = 2500;
const SEEK_NUDGE_S = 10;
const SEEK_NUDGE_LARGE_S = 30;

let currentState: WallState | null = null;
let videoElement: HTMLVideoElement | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function readQuadrant(): Quadrant {
  const arg = process.argv.find((a) => a.startsWith("--quadrant="));
  const value = arg?.split("=")[1] as Quadrant | undefined;
  if (!value) throw new Error("preload: --quadrant=<q> not provided");
  return value;
}

function sendCommand(command: WallCommand): void {
  ipcRenderer.send("display:command", command);
}

function applyCrop(
  video: HTMLVideoElement,
  quadrant: Quadrant,
  fitMode: FitMode,
  source: Dimensions | null,
): void {
  const offsets: Record<Quadrant, [string, string]> = {
    "top-left": ["0", "0"],
    "top-right": ["-100vw", "0"],
    "bottom-left": ["0", "-100vh"],
    "bottom-right": ["-100vw", "-100vh"],
  };
  const [left, top] = offsets[quadrant];

  let widthRule = "200vw";
  let heightRule = "200vh";
  let objectFit = fitMode === "letterbox" ? "contain" : "cover";

  if (fitMode === "letterbox" && source) {
    const wallAspect = window.screen.width / window.screen.height;
    const srcAspect = source.width / source.height;
    if (srcAspect > wallAspect) {
      const scale = (wallAspect / srcAspect) * 200;
      heightRule = `${scale}vh`;
    } else {
      const scale = (srcAspect / wallAspect) * 200;
      widthRule = `${scale}vw`;
    }
    objectFit = "fill";
  }

  Object.assign(video.style, {
    position: "fixed",
    left,
    top,
    width: widthRule,
    height: heightRule,
    objectFit,
    objectPosition: "center",
    margin: "0",
    padding: "0",
    maxWidth: "none",
    maxHeight: "none",
    zIndex: "2147483646",
    background: "#000",
  } satisfies Partial<CSSStyleDeclaration>);

  ensureGlobalStyles();
}

function ensureGlobalStyles(): void {
  if (document.getElementById("vss-globals")) return;
  const style = document.createElement("style");
  style.id = "vss-globals";
  style.textContent = `
    html, body { background: #000 !important; overflow: hidden !important; }
    video { background: #000 !important; }
  `;
  document.documentElement.appendChild(style);
}

function findLargestVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return null;
  videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  return videos[0] ?? null;
}

function attachToVideo(video: HTMLVideoElement): void {
  if (videoElement === video) return;
  videoElement = video;

  video.muted = currentState ? currentState.audio_owner !== QUADRANT : true;
  reapplyCropFromState();
  Overlay.bindToVideo(video);

  if (currentState && !currentState.paused) {
    video.play().catch(() => {});
  }
}

function reapplyCropFromState(): void {
  if (!videoElement || !currentState) return;
  applyCrop(
    videoElement,
    QUADRANT,
    currentState.fit_mode,
    currentState.source_dimensions,
  );
  videoElement.muted = currentState.audio_owner !== QUADRANT;
}

function observeForVideo(): void {
  const initial = findLargestVideo();
  if (initial) attachToVideo(initial);

  const observer = new MutationObserver(() => {
    const v = findLargestVideo();
    if (v && v !== videoElement) attachToVideo(v);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function startHeartbeats(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!videoElement) return;
    const dims: Dimensions | null =
      videoElement.videoWidth && videoElement.videoHeight
        ? { width: videoElement.videoWidth, height: videoElement.videoHeight }
        : null;
    ipcRenderer.send("display:heartbeat", {
      currentTime: videoElement.currentTime,
      paused: videoElement.paused,
      readyState: videoElement.readyState,
      sourceDimensions: dims,
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function applyStateToVideo(state: WallState, previous: WallState | null): void {
  if (!videoElement) return;
  videoElement.muted = state.audio_owner !== QUADRANT;
  reapplyCropFromState();

  if (previous?.paused !== state.paused) {
    if (state.paused) {
      videoElement.pause();
    } else {
      videoElement.play().catch(() => {});
    }
  }

  if (previous?.seek_epoch !== state.seek_epoch) {
    try {
      videoElement.currentTime = state.current_time;
    } catch (e) {
      console.warn("seek failed:", e);
    }
  }
}

// =========================================================================
// Overlay UI: floating bar with play/pause + seek, auto-hides on idle.
// =========================================================================

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;
}

const Overlay = (() => {
  let root: HTMLDivElement | null = null;
  let playBtn: HTMLButtonElement | null = null;
  let scrub: HTMLInputElement | null = null;
  let timeLabel: HTMLDivElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let scrubbing = false;
  let attachedVideo: HTMLVideoElement | null = null;

  function inject(): void {
    if (root) return;

    const css = document.createElement("style");
    css.id = "vss-overlay-style";
    css.textContent = `
      #vss-overlay {
        position: fixed;
        left: 50%;
        bottom: 32px;
        transform: translateX(-50%);
        width: min(720px, calc(100vw - 64px));
        padding: 12px 16px;
        background: rgba(20, 22, 28, 0.85);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        color: #fff;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 12px;
        opacity: 0;
        transition: opacity 200ms ease;
        pointer-events: none;
      }
      #vss-overlay.visible { opacity: 1; pointer-events: auto; }
      #vss-overlay button {
        background: rgba(255,255,255,0.1);
        border: none;
        color: #fff;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }
      #vss-overlay button:hover { background: rgba(255,255,255,0.18); }
      #vss-overlay .vss-time {
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
        flex: 0 0 auto;
        min-width: 96px;
        text-align: right;
      }
      #vss-overlay input[type=range] {
        flex: 1 1 0;
        min-width: 0;
        accent-color: #6aa6ff;
      }
      .vss-cursor-hidden, .vss-cursor-hidden * { cursor: none !important; }
    `;
    document.documentElement.appendChild(css);

    root = document.createElement("div");
    root.id = "vss-overlay";
    root.innerHTML = `
      <button id="vss-play" title="Space">▶</button>
      <input id="vss-scrub" type="range" min="0" max="1000" value="0" step="1">
      <div class="vss-time" id="vss-time">0:00 / 0:00</div>
    `;
    document.documentElement.appendChild(root);

    playBtn = root.querySelector("#vss-play");
    scrub = root.querySelector("#vss-scrub");
    timeLabel = root.querySelector("#vss-time");

    playBtn?.addEventListener("click", () => {
      togglePlayPause();
      showOverlay();
    });

    scrub?.addEventListener("input", () => {
      scrubbing = true;
      updateTimeLabel();
      showOverlay();
    });

    scrub?.addEventListener("change", () => {
      if (!attachedVideo || !scrub) return;
      const duration = attachedVideo.duration;
      if (isFinite(duration) && duration > 0) {
        const target = (Number(scrub.value) / 1000) * duration;
        sendCommand({ type: "seek", to: target });
      }
      scrubbing = false;
    });

    // Show on any user activity; hide after idle.
    const activity = () => showOverlay();
    window.addEventListener("mousemove", activity, true);
    window.addEventListener("mousedown", activity, true);
    window.addEventListener("touchstart", activity, true);
    window.addEventListener("keydown", onKeyDown, true);
  }

  function onKeyDown(e: KeyboardEvent): void {
    let handled = true;
    switch (e.key) {
      case " ":
      case "k":
        togglePlayPause();
        break;
      case "ArrowLeft":
        nudgeSeek(-(e.shiftKey ? SEEK_NUDGE_LARGE_S : SEEK_NUDGE_S));
        break;
      case "ArrowRight":
        nudgeSeek(+(e.shiftKey ? SEEK_NUDGE_LARGE_S : SEEK_NUDGE_S));
        break;
      case "Home":
        sendCommand({ type: "seek", to: 0 });
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      showOverlay();
    }
  }

  function togglePlayPause(): void {
    if (!currentState) return;
    sendCommand(currentState.paused ? { type: "play" } : { type: "pause" });
  }

  function nudgeSeek(delta: number): void {
    if (!attachedVideo) return;
    const target = Math.max(0, attachedVideo.currentTime + delta);
    sendCommand({ type: "seek", to: target });
  }

  function showOverlay(): void {
    if (!root) return;
    root.classList.add("visible");
    document.documentElement.classList.remove("vss-cursor-hidden");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideOverlay, OVERLAY_HIDE_AFTER_MS);
  }

  function hideOverlay(): void {
    if (!root) return;
    root.classList.remove("visible");
    document.documentElement.classList.add("vss-cursor-hidden");
  }

  function bindToVideo(video: HTMLVideoElement): void {
    attachedVideo = video;
    video.addEventListener("timeupdate", updateTimeLabel);
    video.addEventListener("durationchange", updateTimeLabel);
    video.addEventListener("seeked", updateTimeLabel);
    video.addEventListener("play", updatePlayIcon);
    video.addEventListener("pause", updatePlayIcon);
    updateTimeLabel();
    updatePlayIcon();
  }

  function updateTimeLabel(): void {
    if (!attachedVideo || !timeLabel || !scrub) return;
    const cur = attachedVideo.currentTime;
    const dur = isFinite(attachedVideo.duration) ? attachedVideo.duration : 0;
    timeLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    if (!scrubbing && dur > 0) {
      scrub.value = String(Math.round((cur / dur) * 1000));
    }
  }

  function updatePlayIcon(): void {
    if (!attachedVideo || !playBtn) return;
    playBtn.textContent = attachedVideo.paused ? "▶" : "❚❚";
  }

  return { inject, bindToVideo };
})();

// =========================================================================
// Wire up IPC + lifecycle
// =========================================================================

ipcRenderer.on("display:state", (_e, state: WallState) => {
  const previous = currentState;
  currentState = state;
  applyStateToVideo(state, previous);
});

ipcRenderer.on("display:correct", (_e, to: number) => {
  if (!videoElement) return;
  if (Math.abs(videoElement.currentTime - to) > CORRECTION_TOLERANCE_S) {
    try {
      videoElement.currentTime = to;
    } catch (e) {
      console.warn("correction failed:", e);
    }
  }
});

window.addEventListener("DOMContentLoaded", () => {
  Overlay.inject();
  observeForVideo();
  startHeartbeats();
});
