import { ipcRenderer } from "electron";
import type { Quadrant } from "@proto/Quadrant";
import type { WallState } from "@proto/WallState";
import type { Dimensions } from "@proto/Dimensions";
import type { FitMode } from "@proto/FitMode";

const QUADRANT: Quadrant = readQuadrant();
const HEARTBEAT_INTERVAL_MS = 250;
const CORRECTION_TOLERANCE_S = 0.05;

let currentState: WallState | null = null;
let videoElement: HTMLVideoElement | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function readQuadrant(): Quadrant {
  const arg = process.argv.find((a) => a.startsWith("--quadrant="));
  const value = arg?.split("=")[1] as Quadrant | undefined;
  if (!value) throw new Error("preload: --quadrant=<q> not provided");
  return value;
}

function applyCrop(
  video: HTMLVideoElement,
  quadrant: Quadrant,
  fitMode: FitMode,
  source: Dimensions | null,
): void {
  // The crop strategy: scale the video to 2x viewport (= full wall) and offset
  // it so this quadrant shows the corresponding quarter.
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
    // For letterbox, compute the largest 2x-monitor box that fits the source
    // aspect ratio within a 2-monitor frame. Assumes all four monitors are
    // identical — the common case for a 2x2 wall.
    const wallAspect = window.screen.width / window.screen.height; // single monitor
    const srcAspect = source.width / source.height;
    if (srcAspect > wallAspect) {
      // source wider than wall — letterbox vertically
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
    zIndex: "2147483647",
    background: "#000",
  } satisfies Partial<CSSStyleDeclaration>);

  // Hide chrome on the page — players have overlay UI that breaks the crop.
  // Use a stylesheet so it survives the player toggling its own visibility.
  ensureGlobalStyles();
}

function ensureGlobalStyles(): void {
  if (document.getElementById("vss-globals")) return;
  const style = document.createElement("style");
  style.id = "vss-globals";
  style.textContent = `
    html, body { background: #000 !important; overflow: hidden !important; cursor: none !important; }
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
  observeForVideo();
  startHeartbeats();
});
