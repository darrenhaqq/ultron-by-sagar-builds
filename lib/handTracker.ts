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

// A grab must be deliberate. We combine finger curvature and proximity to the
// palm, then require several consecutive frames before grabbing/releasing.
const GRAB_ON_CURL_RATIO = 0.82;
const GRAB_OFF_CURL_RATIO = 0.90;
const GRAB_ON_PALM_RATIO = 1.28;
const GRAB_OFF_PALM_RATIO = 1.48;
const GRAB_ON_FINGERS = 3;
const GRAB_HOLD_FINGERS = 2;
const CLOSE_FRAMES_TO_GRAB = 4;
const OPEN_FRAMES_TO_RELEASE = 4;

// Motion filtering. The orb should clearly follow the fist without copying
// tiny camera/landmark tremors.
const ROTATE_SPEED = 8.0;
const CENTER_SMOOTHING = 0.42;
const VELOCITY_SMOOTHING = 0.48;
const MAX_FRAME_DELTA = 0.05;
const MOVE_DEADZONE = 0.0016;

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

export type GestureMode = "idle" | "arming" | "grab";
export type TrackerPhase =
  | "requesting-camera"
  | "camera-ready"
  | "loading-model"
  | "tracking";

export interface TrackerStatus {
  hands: number;
  grips: number;
  mode: GestureMode;
  grabProgress: number;
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
  closeFrames: number;
  openFrames: number;
  grab: Point;
  velocity: Point;
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
    x += 1 - lm[id].x;
    y += lm[id].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}

function palmScale(lm: NormalizedLandmark[]): number {
  const vertical = dist3d(lm[WRIST], lm[MIDDLE_MCP]);
  const horizontal = dist3d(lm[INDEX_MCP], lm[PINKY_MCP]);
  return Math.max(1e-6, (vertical + horizontal) / 2);
}

function fingerCurlRatio(
  lm: NormalizedLandmark[],
  [mcp, pip, dip, tip]: [number, number, number, number],
): number {
  const direct = dist3d(lm[mcp], lm[tip]);
  const path =
    dist3d(lm[mcp], lm[pip]) +
    dist3d(lm[pip], lm[dip]) +
    dist3d(lm[dip], lm[tip]);
  return path > 1e-6 ? direct / path : 1;
}

function fingerPalmRatio(
  lm: NormalizedLandmark[],
  finger: [number, number, number, number],
): number {
  const tip = finger[3];
  return dist3d(lm[tip], lm[MIDDLE_MCP]) / palmScale(lm);
}

function curledFingerCount(
  lm: NormalizedLandmark[],
  curlThreshold: number,
  palmThreshold: number,
): number {
  let count = 0;
  for (const finger of FINGERS) {
    const curledByShape = fingerCurlRatio(lm, finger) < curlThreshold;
    const curledTowardPalm = fingerPalmRatio(lm, finger) < palmThreshold;
    if (curledByShape || curledTowardPalm) count += 1;
  }
  return count;
}

function shouldStartGrab(lm: NormalizedLandmark[]): boolean {
  return (
    curledFingerCount(lm, GRAB_ON_CURL_RATIO, GRAB_ON_PALM_RATIO) >=
    GRAB_ON_FINGERS
  );
}

function shouldKeepGrab(lm: NormalizedLandmark[]): boolean {
  return (
    curledFingerCount(lm, GRAB_OFF_CURL_RATIO, GRAB_OFF_PALM_RATIO) >=
    GRAB_HOLD_FINGERS
  );
}

function clampDelta(value: number): number {
  return Math.max(-MAX_FRAME_DELTA, Math.min(MAX_FRAME_DELTA, value));
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
  private lastStatus: TrackerStatus = {
    hands: 0,
    grips: 0,
    mode: "idle",
    grabProgress: 0,
  };

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
        frameRate: { ideal: 30, max: 30 },
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
    this.emitStatus({ hands: 0, grips: 0, mode: "idle", grabProgress: 0 });
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
      const labels = result.handedness.map(
        (h) => h[0]?.categoryName ?? "?",
      );
      this.processHands(result.landmarks, labels);
      this.drawOverlay(result.landmarks, labels);
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
    let bestProgress = 0;

    landmarks.forEach((lm, i) => {
      const label = labels[i] ?? String(i);
      seen.add(label);
      const raw = palmCenter(lm);

      let state = this.handStates.get(label);
      if (!state) {
        state = {
          gripping: false,
          closeFrames: 0,
          openFrames: 0,
          grab: raw,
          velocity: { x: 0, y: 0 },
        };
        this.handStates.set(label, state);
      }

      if (!state.gripping) {
        if (shouldStartGrab(lm)) {
          state.closeFrames = Math.min(
            CLOSE_FRAMES_TO_GRAB,
            state.closeFrames + 1,
          );
        } else {
          state.closeFrames = 0;
        }
        state.openFrames = 0;

        if (state.closeFrames >= CLOSE_FRAMES_TO_GRAB) {
          state.gripping = true;
          state.openFrames = 0;
          state.velocity = { x: 0, y: 0 };
        }
      } else {
        if (shouldKeepGrab(lm)) {
          state.openFrames = 0;
        } else {
          state.openFrames = Math.min(
            OPEN_FRAMES_TO_RELEASE,
            state.openFrames + 1,
          );
        }

        if (state.openFrames >= OPEN_FRAMES_TO_RELEASE) {
          state.gripping = false;
          state.closeFrames = 0;
          state.openFrames = 0;
          state.velocity = { x: 0, y: 0 };
        }
      }

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * CENTER_SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * CENTER_SMOOTHING,
      };

      bestProgress = Math.max(
        bestProgress,
        state.gripping ? 1 : state.closeFrames / CLOSE_FRAMES_TO_GRAB,
      );

      if (state.gripping) activeGrabs.push(state.grab);
    });

    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    let mode: GestureMode = "idle";
    if (activeGrabs.length === 1) mode = "grab";
    else if (activeGrabs.length === 0 && bestProgress > 0) mode = "arming";

    if (mode !== this.prevMode) {
      this.prevGrab = null;
      this.prevMode = mode;
    }

    if (mode === "grab") {
      const grab = activeGrabs[0];
      const activeState = [...this.handStates.values()].find((s) => s.gripping);

      if (this.prevGrab && activeState) {
        const rawDx = clampDelta(grab.x - this.prevGrab.x);
        const rawDy = clampDelta(grab.y - this.prevGrab.y);

        activeState.velocity.x +=
          (rawDx - activeState.velocity.x) * VELOCITY_SMOOTHING;
        activeState.velocity.y +=
          (rawDy - activeState.velocity.y) * VELOCITY_SMOOTHING;

        const dx =
          Math.abs(activeState.velocity.x) > MOVE_DEADZONE
            ? activeState.velocity.x
            : 0;
        const dy =
          Math.abs(activeState.velocity.y) > MOVE_DEADZONE
            ? activeState.velocity.y
            : 0;

        if (dx !== 0 || dy !== 0) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevGrab = grab;
    } else {
      this.prevGrab = null;
    }

    this.emitStatus({
      hands: landmarks.length,
      grips: activeGrabs.length,
      mode,
      grabProgress: mode === "grab" ? 1 : bestProgress,
    });
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.grips !== this.lastStatus.grips ||
      status.mode !== this.lastStatus.mode ||
      Math.abs(status.grabProgress - this.lastStatus.grabProgress) > 0.01
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    landmarks.forEach((lm, i) => {
      const label = labels[i] ?? String(i);
      const state = this.handStates.get(label);
      const gripping = state?.gripping ?? false;
      const progress = gripping
        ? 1
        : Math.min(1, (state?.closeFrames ?? 0) / CLOSE_FRAMES_TO_GRAB);
      const arming = !gripping && progress > 0;

      ctx.strokeStyle = gripping
        ? "rgba(255,255,255,0.98)"
        : arming
          ? "rgba(255,220,120,0.95)"
          : "rgba(255,170,48,0.58)";
      ctx.lineWidth = gripping ? 2.7 : arming ? 2 : 1;

      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        ctx.beginPath();
        ctx.moveTo((1 - pa.x) * width, pa.y * height);
        ctx.lineTo((1 - pb.x) * width, pb.y * height);
        ctx.stroke();
      }

      for (const p of lm) {
        const x = (1 - p.x) * width;
        const y = p.y * height;
        ctx.fillStyle = gripping
          ? "#ffffff"
          : arming
            ? "#ffdc78"
            : "rgba(255,190,85,0.82)";
        ctx.beginPath();
        ctx.arc(x, y, gripping ? 3.2 : arming ? 2.6 : 2, 0, Math.PI * 2);
        ctx.fill();
      }

      const palm = palmCenter(lm);
      const px = palm.x * width;
      const py = palm.y * height;
      const radius = gripping ? 12 : 6 + progress * 5;

      ctx.strokeStyle = gripping
        ? "#ffffff"
        : arming
          ? "#ffdc78"
          : "rgba(255,204,102,0.7)";
      ctx.lineWidth = gripping ? 3 : arming ? 2.2 : 1.5;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.stroke();

      if (arming) {
        ctx.beginPath();
        ctx.arc(
          px,
          py,
          radius + 4,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * progress,
        );
        ctx.stroke();
      }

      if (gripping) {
        ctx.font = "bold 9px Courier New";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffffff";
        ctx.fillText("GRAB", px, Math.max(10, py - 16));
      }
    });
  }
}

function dist3d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}
