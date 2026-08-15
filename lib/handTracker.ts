import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const WRIST = 0;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_DIP = 7;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_DIP = 11;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_DIP = 15;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_DIP = 19;
const PINKY_TIP = 20;

// Explicit "grab" gesture: at least 3 fingers must be clearly curled.
// Hysteresis prevents accidental grab/release flicker.
const GRAB_ON_CURL_RATIO = 0.78;
const GRAB_OFF_CURL_RATIO = 0.88;
const GRAB_ON_FINGERS = 3;
const GRAB_HOLD_FINGERS = 2;

// Direct orb response. Hand movement is intentionally obvious, but frame deltas
// are capped so a tracking jump cannot fling the orb across the scene.
const ROTATE_SPEED = 7.5;
const SMOOTHING = 0.58;
const MAX_FRAME_DELTA = 0.06;
const MOVE_DEADZONE = 0.001;

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const FINGERS: Array<[number, number, number, number]> = [
  [INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP],
  [MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP],
  [RING_MCP, RING_PIP, RING_DIP, RING_TIP],
  [PINKY_MCP, PINKY_PIP, PINKY_DIP, PINKY_TIP],
];

export type GestureMode = "idle" | "grab";
export type TrackerPhase =
  | "requesting-camera"
  | "camera-ready"
  | "loading-model"
  | "tracking";

export interface TrackerStatus {
  hands: number;
  grips: number;
  mode: GestureMode;
}

export interface HandTrackerCallbacks {
  onRotate(deltaTheta: number, deltaPhi: number): void;
  onStatus(status: TrackerStatus): void;
  onPhase?(phase: TrackerPhase): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  gripping: boolean;
  grab: Point;
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("VIDEO_METADATA_TIMEOUT"));
    }, 8000);

    const onLoaded = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("VIDEO_METADATA_ERROR"));
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function palmCenter(lm: NormalizedLandmark[]): Point {
  const ids = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  let x = 0;
  let y = 0;
  for (const id of ids) {
    x += 1 - lm[id].x; // mirrored to match the preview
    y += lm[id].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}

function fingerCurlRatio(
  lm: NormalizedLandmark[],
  [mcp, pip, dip, tip]: [number, number, number, number],
): number {
  const direct = dist2d(lm[mcp], lm[tip]);
  const path =
    dist2d(lm[mcp], lm[pip]) +
    dist2d(lm[pip], lm[dip]) +
    dist2d(lm[dip], lm[tip]);
  return path > 1e-6 ? direct / path : 1;
}

function curledFingerCount(
  lm: NormalizedLandmark[],
  threshold: number,
): number {
  let count = 0;
  for (const finger of FINGERS) {
    if (fingerCurlRatio(lm, finger) < threshold) count += 1;
  }
  return count;
}

function shouldStartGrab(lm: NormalizedLandmark[]): boolean {
  return curledFingerCount(lm, GRAB_ON_CURL_RATIO) >= GRAB_ON_FINGERS;
}

function shouldKeepGrab(lm: NormalizedLandmark[]): boolean {
  return curledFingerCount(lm, GRAB_OFF_CURL_RATIO) >= GRAB_HOLD_FINGERS;
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastVideoTime = -1;

  private handStates = new Map<string, HandState>();
  private prevMode: GestureMode = "idle";
  private prevGrab: Point | null = null;
  private lastStatus: TrackerStatus = { hands: 0, grips: 0, mode: "idle" };

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("CAMERA_API_UNAVAILABLE");
    }

    this.callbacks.onPhase?.("requesting-camera");

    const mobile = isIOSDevice();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: mobile ? 480 : 640 },
        height: { ideal: mobile ? 360 : 480 },
      },
      audio: false,
    });

    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.setAttribute("muted", "");
    this.video.setAttribute("autoplay", "");
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("webkit-playsinline", "");
    this.video.srcObject = this.stream;

    await waitForMetadata(this.video);
    await this.video.play();
    this.callbacks.onPhase?.("camera-ready");

    this.callbacks.onPhase?.("loading-model");
    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);

    const commonOptions = {
      baseOptions: { modelAssetPath: MODEL_URL },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: mobile ? 0.45 : 0.5,
      minHandPresenceConfidence: mobile ? 0.45 : 0.5,
      minTrackingConfidence: mobile ? 0.45 : 0.5,
    };

    const delegates: Array<"CPU" | "GPU"> = mobile
      ? ["CPU", "GPU"]
      : ["GPU", "CPU"];

    let lastError: unknown = null;
    for (const delegate of delegates) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          ...commonOptions,
          baseOptions: { ...commonOptions.baseOptions, delegate },
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!this.landmarker) {
      throw lastError instanceof Error
        ? lastError
        : new Error("MEDIAPIPE_INIT_FAILED");
    }

    this.running = true;
    this.callbacks.onPhase?.("tracking");
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.handStates.clear();
    this.prevMode = "idle";
    this.prevGrab = null;
    this.lastVideoTime = -1;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, grips: 0, mode: "idle" });
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    try {
      const result = this.landmarker.detectForVideo(
        this.video,
        performance.now(),
      );
      this.processHands(
        result.landmarks,
        result.handedness.map((h) => h[0]?.categoryName ?? "?"),
      );
      this.drawOverlay(result.landmarks);
    } catch {
      // Ignore an isolated bad frame; keep tracking alive.
    }
  };

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const activeGrabs: Point[] = [];
    const seen = new Set<string>();

    landmarks.forEach((lm, i) => {
      const label = labels[i] ?? String(i);
      seen.add(label);
      const raw = palmCenter(lm);

      let state = this.handStates.get(label);
      if (!state) {
        state = { gripping: false, grab: raw };
        this.handStates.set(label, state);
      }

      state.gripping = state.gripping
        ? shouldKeepGrab(lm)
        : shouldStartGrab(lm);

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      if (state.gripping) activeGrabs.push(state.grab);
    });

    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    // One closed fist has one meaning: the orb is grabbed.
    // Two simultaneous fists are deliberately ignored to avoid ambiguity.
    const mode: GestureMode = activeGrabs.length === 1 ? "grab" : "idle";

    if (mode !== this.prevMode) {
      this.prevGrab = null;
      this.prevMode = mode;
    }

    if (mode === "grab") {
      const grab = activeGrabs[0];
      if (this.prevGrab) {
        const dx = Math.max(
          -MAX_FRAME_DELTA,
          Math.min(MAX_FRAME_DELTA, grab.x - this.prevGrab.x),
        );
        const dy = Math.max(
          -MAX_FRAME_DELTA,
          Math.min(MAX_FRAME_DELTA, grab.y - this.prevGrab.y),
        );

        if (Math.abs(dx) > MOVE_DEADZONE || Math.abs(dy) > MOVE_DEADZONE) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevGrab = grab;
    }

    this.emitStatus({ hands: landmarks.length, grips: activeGrabs.length, mode });
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.grips !== this.lastStatus.grips ||
      status.mode !== this.lastStatus.mode
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarks) {
      const gripping = shouldStartGrab(lm);

      ctx.strokeStyle = gripping
        ? "rgba(255,240,179,0.98)"
        : "rgba(255,170,48,0.58)";
      ctx.lineWidth = gripping ? 2.5 : 1;

      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        ctx.beginPath();
        ctx.moveTo((1 - pa.x) * width, pa.y * height);
        ctx.lineTo((1 - pb.x) * width, pb.y * height);
        ctx.stroke();
      }

      for (let i = 0; i < lm.length; i++) {
        const p = lm[i];
        const x = (1 - p.x) * width;
        const y = p.y * height;
        ctx.fillStyle = gripping
          ? "#fff0b3"
          : "rgba(255,190,85,0.82)";
        ctx.beginPath();
        ctx.arc(x, y, gripping ? 3.2 : 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Palm marker = the point actually used to drive the orb.
      const palm = palmCenter(lm);
      ctx.strokeStyle = gripping ? "#ffffff" : "rgba(255,204,102,0.7)";
      ctx.lineWidth = gripping ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(palm.x * width, palm.y * height, gripping ? 9 : 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
