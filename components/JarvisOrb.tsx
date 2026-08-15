"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import {
  HandTracker,
  type TrackerPhase,
  type TrackerStatus,
} from "@/lib/handTracker";

type CameraState = "off" | "requesting" | "preview" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "VEILLE",
  spin: "ROTATION",
  zoom: "ZOOM",
};

function describeTrackerError(error: unknown, cameraReady: boolean): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "ACCÈS CAMÉRA REFUSÉ";
    }
    if (error.name === "NotFoundError") {
      return "AUCUNE CAMÉRA DÉTECTÉE";
    }
    if (error.name === "NotReadableError") {
      return "CAMÉRA DÉJÀ UTILISÉE";
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CAMERA_API_UNAVAILABLE")) {
    return "API CAMÉRA INDISPONIBLE";
  }
  if (message.includes("VIDEO_METADATA")) {
    return "FLUX CAMÉRA OUVERT MAIS VIDÉO INDISPONIBLE";
  }

  return cameraReady
    ? `CAMÉRA OK · MEDIAPIPE ÉCHEC${message ? ` · ${message.slice(0, 70)}` : ""}`
    : `INITIALISATION CAMÉRA ÉCHOUÉE${message ? ` · ${message.slice(0, 70)}` : ""}`;
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const cameraReadyRef = useRef(false);

  const [camera, setCamera] = useState<CameraState>("off");
  const [phase, setPhase] = useState<TrackerPhase | null>(null);
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    cameraReadyRef.current = false;
    setCamera("off");
    setPhase(null);
    setError(null);
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    cameraReadyRef.current = false;
    setCamera("requesting");
    setPhase("requesting-camera");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
      onPhase: (nextPhase) => {
        setPhase(nextPhase);
        if (nextPhase === "camera-ready" || nextPhase === "loading-model") {
          cameraReadyRef.current = true;
          setCamera("preview");
        } else if (nextPhase === "tracking") {
          cameraReadyRef.current = true;
          setCamera("on");
        }
      },
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
    } catch (err) {
      const hasCamera = cameraReadyRef.current;
      setCamera("error");
      setError(describeTrackerError(err, hasCamera));

      // If camera itself failed there is nothing useful to keep alive.
      // If only MediaPipe failed, keep the live camera visible for diagnosis.
      if (!hasCamera) {
        trackerRef.current = null;
        tracker.stop();
      }
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const retryGestures = useCallback(() => {
    stopGestures();
    window.setTimeout(() => void startGestures(), 50);
  }, [startGestures, stopGestures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const showCamera = camera !== "off";
  const cameraOn = camera === "on";

  const cameraLabel = (() => {
    if (camera === "requesting") return "AUTORISATION CAMÉRA…";
    if (camera === "preview" && phase === "loading-model") return "CAMÉRA OK · CHARGEMENT MEDIAPIPE…";
    if (camera === "preview") return "CAMÉRA OK";
    if (camera === "error") return error ?? "ERREUR";
    if (status.hands > 0) {
      return `${status.hands} MAIN${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`;
    }
    return "CAMÉRA + MEDIAPIPE OK · MONTREZ VOS MAINS";
  })();

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">J.A.R.V.I.S. V0</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> rotation&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCE + BOUGE</span> rotation&nbsp;&nbsp;
            <span className="key">2 MAINS PINCÉES</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> gestes&nbsp;&nbsp;
            <span className="key">R</span> reset
          </div>
        )}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${showCamera ? " visible" : ""}`}>
          <video
            ref={videoRef}
            muted
            autoPlay
            playsInline
            className="camera-video"
          />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className={`camera-status${camera === "error" ? " camera-status-error" : ""}`}>
            {cameraLabel}
          </div>
        </div>

        <div className="hud-row">
          {camera === "error" ? (
            <button type="button" className="hud-btn" onClick={retryGestures}>
              RÉESSAYER
            </button>
          ) : (
            <button
              type="button"
              className="hud-btn"
              aria-pressed={cameraOn}
              onClick={toggleGestures}
              disabled={camera === "requesting"}
            >
              {camera === "requesting"
                ? "CAMÉRA…"
                : camera === "preview"
                  ? "CHARGEMENT…"
                  : cameraOn
                    ? "GESTES ON"
                    : "ACTIVER CAMÉRA + GESTES"}
            </button>
          )}
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom avant">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom arrière">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
