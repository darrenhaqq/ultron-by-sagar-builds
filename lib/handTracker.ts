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
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

// Generous thresholds: users should not need a perfectly closed pinch.
const PINCH_ON_RATIO = 0.60;
const PINCH_OFF_RATIO = 0.85;
const PINCH_ON_ABS = 0.075;
const PINCH_OFF_ABS = 0.105;

// Stronger response so camera/orb movement is immediately visible.
const ROTATE_SPEED = 10.0;
const SMOOTHING = 0.65;
const MAX_FRAME_DELTA = 0.075;

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export type GestureMode = "idle" | "spin" | "zoom";
export type TrackerPhase =
  | "requesting-camera"
  | "camera-ready"
  | "loading-model"
  | "tracking";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
}

export interface HandTrackerCallbacks {
  onRotate(deltaTheta: number, deltaPhi: number): void;
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
  onPhase?(phase: TrackerPhase): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  pinching: boolean;
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

function pinchMetrics(lm: NormalizedLandmark[]) {
  const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
  const distance = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]);
  const ratio = handScale > 1e-6 ? distance / handScale : Number.POSITIVE_INFINITY;
  return { distance, ratio };
}

function isPinchStarting(lm: NormalizedLandmark[]): boolean {
  const { distance, ratio } = pinchMetrics(lm);
  return ratio < PINCH_ON_RATIO || distance < PINCH_ON_ABS;
}

function isPinchStillHeld(lm: NormalizedLandmark[]): boolean {
  const { distance, ratio } = pinchMetrics(lm);
  // Releasing requires both measures to be clearly open. This prevents flicker.
  return ratio < PINCH_OFF_RATIO || distance < PINCH_OFF_ABS;
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
  private prevSpinGrab: Point | null = null;
  private prevZoomDist: number | null = null;
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle" };

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
    this.prevSpinGrab = null;
    this.prevZoomDist = null;
    this.lastVideoTime = -1;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, mode: "idle" });
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
    const pinchedGrabs: Point[] = [];
    const seen = new Set<string>();

    landmarks.forEach((lm, i) => {
      const label = labels[i] ?? String(i);
      seen.add(label);

      const raw: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.handStates.get(label);
      if (!state) {
        state = { pinching: false, grab: raw };
        this.handStates.set(label, state);
      }

      state.pinching = state.pinching
        ? isPinchStillHeld(lm)
        : isPinchStarting(lm);

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      if (state.pinching) pinchedGrabs.push(state.grab);
    });

    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    const mode: GestureMode =
      pinchedGrabs.length >= 2
        ? "zoom"
        : pinchedGrabs.length === 1
          ? "spin"
          : "idle";

    if (mode !== this.prevMode) {
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = mode;
    }

    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.prevSpinGrab) {
        const dx = Math.max(-MAX_FRAME_DELTA, Math.min(MAX_FRAME_DELTA, grab.x - this.prevSpinGrab.x));
        const dy = Math.max(-MAX_FRAME_DELTA, Math.min(MAX_FRAME_DELTA, grab.y - this.prevSpinGrab.y));
        if (Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevSpinGrab = grab;
    } else if (mode === "zoom") {
      const d = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      if (this.prevZoomDist && d > 1e-4) {
        const factor = Math.min(1.22, Math.max(0.82, this.prevZoomDist / d));
        this.callbacks.onZoom(factor);
      }
      this.prevZoomDist = d;
    }

    this.emitStatus({ hands: landmarks.length, mode });
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
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
      const pinched = isPinchStarting(lm);

      // Full 21-point hand skeleton so the user can verify whole-hand tracking.
      ctx.strokeStyle = pinched
        ? "rgba(255,204,102,0.95)"
        : "rgba(255,170,48,0.55)";
      ctx.lineWidth = pinched ? 2 : 1;
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
        const isControlTip = i === THUMB_TIP || i === INDEX_TIP;
        ctx.fillStyle = isControlTip
          ? pinched
            ? "#fff0b3"
            : "#ffcc66"
          : "rgba(255,170,48,0.75)";
        ctx.beginPath();
        ctx.arc(x, y, isControlTip ? (pinched ? 5 : 4) : 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Explicit thumb-index bridge: it becomes bright when the pinch is accepted.
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      ctx.strokeStyle = pinched ? "#fff0b3" : "rgba(255,170,48,0.45)";
      ctx.lineWidth = pinched ? 3 : 1;
      ctx.beginPath();
      ctx.moveTo((1 - thumb.x) * width, thumb.y * height);
      ctx.lineTo((1 - index.x) * width, index.y * height);
      ctx.stroke();
    }
  }
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
