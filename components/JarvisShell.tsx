"use client";

import {
  type ComponentType,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  runJarvisCore,
  type JarvisCoreResult,
  type WorkspaceSection,
} from "@/lib/jarvisCore";
import coreStyles from "@/components/JarvisCore.module.css";

type ImmersiveState = "idle" | "loading" | "ready" | "error";
type CoreState = "idle" | "running" | "done" | "error";

const WORKSPACE_ITEMS: Array<{
  id: WorkspaceSection;
  label: string;
  detail: string;
}> = [
  { id: "projects", label: "PROJETS", detail: "Travaux, décisions et prochaines actions" },
  { id: "files", label: "FICHIERS", detail: "Documents et éléments associés au contexte" },
  { id: "ideas", label: "IDÉES", detail: "Pistes à explorer et connexions utiles" },
  { id: "research", label: "RECHERCHE", detail: "Sources et résultats réunis par Jarvis" },
];

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
        canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true }),
    );
  } catch {
    return false;
  }
}

export default function JarvisShell() {
  const abortRef = useRef<AbortController | null>(null);
  const [Immersive, setImmersive] = useState<ComponentType | null>(null);
  const [immersiveState, setImmersiveState] = useState<ImmersiveState>("idle");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection | null>(null);
  const [command, setCommand] = useState("");
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [coreState, setCoreState] = useState<CoreState>("idle");
  const [coreResult, setCoreResult] = useState<JarvisCoreResult | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);

  const openImmersive = useCallback(async () => {
    if (immersiveState === "loading" || immersiveState === "ready") return;
    if (!supportsWebGL()) {
      setImmersiveState("error");
      return;
    }

    setImmersiveState("loading");
    try {
      const module = await import("@/components/JarvisOrb");
      setImmersive(() => module.default);
      setImmersiveState("ready");
    } catch {
      setImmersiveState("error");
    }
  }, [immersiveState]);

  const closeImmersive = useCallback(() => {
    setImmersiveState("idle");
    setImmersive(null);
  }, []);

  const executeCommand = useCallback(
    async (rawCommand: string) => {
      const trimmed = rawCommand.trim();
      if (!trimmed || coreState === "running") return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLastCommand(trimmed);
      setCoreState("running");
      setCoreError(null);

      try {
        const result = await runJarvisCore(trimmed, controller.signal);
        if (controller.signal.aborted) return;
        setCoreResult(result);
        setCoreState("done");

        if (result.uiAction.type === "open-workspace") {
          setWorkspaceOpen(true);
          setWorkspaceSection(result.uiAction.section ?? null);
        } else if (result.uiAction.type === "open-immersive") {
          await openImmersive();
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCoreState("error");
        setCoreError("Le Core n’a pas pu terminer cette demande.");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [coreState, openImmersive],
  );

  const submitCommand = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = command.trim();
      if (!trimmed) return;
      setCommand("");
      void executeCommand(trimmed);
    },
    [command, executeCommand],
  );

  const stopCore = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setCoreState("idle");
    setCoreError(null);
  }, []);

  return (
    <main className="jarvis-shell">
      <header className="shell-header">
        <div>
          <div className="shell-kicker">J.A.R.V.I.S.</div>
          <div className="shell-status">
            <span className="status-dot" aria-hidden="true" />
            {coreState === "running" ? " CORE ACTIF" : " MODE LÉGER"}
          </div>
        </div>
        <button
          type="button"
          className="shell-action"
          onClick={() => {
            setWorkspaceOpen((open) => !open);
            setWorkspaceSection(null);
          }}
          aria-pressed={workspaceOpen}
        >
          ESPACE
        </button>
      </header>

      <section className="shell-stage" aria-live="polite">
        {workspaceOpen ? (
          <div className="workspace-shell">
            <div className="workspace-heading">
              <button
                type="button"
                className="workspace-back"
                onClick={() => {
                  if (workspaceSection) setWorkspaceSection(null);
                  else setWorkspaceOpen(false);
                }}
              >
                ←
              </button>
              <div>
                <div className="workspace-title">
                  {workspaceSection
                    ? WORKSPACE_ITEMS.find((item) => item.id === workspaceSection)?.label
                    : "VUE GLOBALE"}
                </div>
                <div className="workspace-subtitle">
                  {workspaceSection
                    ? "Jarvis Core a choisi cette zone selon ton objectif."
                    : "Sélectionne une zone, ou demande directement à Jarvis de l’ouvrir."}
                </div>
              </div>
            </div>

            {workspaceSection ? (
              <div className="workspace-detail">
                <div className="workspace-node workspace-node-active" aria-hidden="true" />
                <p>
                  Cette zone est prête à recevoir ses données réelles depuis les outils du Core, sans charger la 3D ni la caméra.
                </p>
              </div>
            ) : (
              <div className="workspace-grid">
                {WORKSPACE_ITEMS.map((item) => (
                  <button
                    type="button"
                    className="workspace-card"
                    key={item.id}
                    onClick={() => setWorkspaceSection(item.id)}
                  >
                    <span className="workspace-node" aria-hidden="true" />
                    <span className="workspace-card-copy">
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="conversation-home">
            <div
              className={`light-orb${coreState === "running" ? ` ${coreStyles.runningOrb}` : ""}`}
              aria-hidden="true"
            >
              <span />
            </div>
            <h1>Que dois-je faire pour toi&nbsp;?</h1>
            <p>
              Donne-moi l’objectif. Le Core choisit maintenant lui-même la première action utile au lieu d’attendre une commande d’interface précise.
            </p>

            {lastCommand && !coreResult && coreState !== "running" ? (
              <div className="local-command">
                <span>DERNIÈRE DEMANDE</span>
                <strong>{lastCommand}</strong>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {coreState === "running" ? (
        <div className={`${coreStyles.card} ${coreStyles.running}`} role="status">
          <div>
            <span>JARVIS CORE</span>
            <strong>Analyse de l’objectif et choix de l’action…</strong>
          </div>
          <button type="button" onClick={stopCore}>STOP</button>
        </div>
      ) : coreResult ? (
        <div className={coreStyles.card} role="status">
          <div className={coreStyles.copy}>
            <span>{coreResult.mode === "remote" ? "CORE IA" : "CORE LOCAL"}</span>
            <strong>{coreResult.objective}</strong>
            <small>{coreResult.answer}</small>
          </div>
          <div className={coreStyles.plan} aria-label="Plan Jarvis">
            {coreResult.steps.map((step) => (
              <span key={step.id} data-status={step.status} title={step.label}>
                {step.status === "done" ? "✓" : step.status === "blocked" ? "!" : "·"}
              </span>
            ))}
          </div>
        </div>
      ) : coreState === "error" ? (
        <div className={`${coreStyles.card} ${coreStyles.error}`} role="alert">
          {coreError}
        </div>
      ) : null}

      <div className="shell-bottom">
        <form className="command-bar" onSubmit={submitCommand}>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Ex. Jarvis, montre-moi mes projets…"
            aria-label="Commande Jarvis"
            disabled={coreState === "running"}
          />
          <button type="submit" disabled={!command.trim() || coreState === "running"}>
            {coreState === "running" ? "…" : "ENVOYER"}
          </button>
        </form>

        <button
          type="button"
          className="immersive-trigger"
          onClick={openImmersive}
          disabled={immersiveState === "loading"}
        >
          {immersiveState === "loading"
            ? "CHARGEMENT 3D…"
            : immersiveState === "error"
              ? "3D INDISPONIBLE · RÉESSAYER"
              : "OUVRIR LA VUE IMMERSIVE"}
        </button>
      </div>

      {Immersive && immersiveState === "ready" ? (
        <section className="immersive-layer" aria-label="Vue immersive Jarvis">
          <Immersive />
          <button
            type="button"
            className="immersive-close"
            onClick={closeImmersive}
            aria-label="Fermer la vue immersive"
          >
            FERMER
          </button>
        </section>
      ) : null}
    </main>
  );
}
