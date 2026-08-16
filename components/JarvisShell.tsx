"use client";

import {
  type ComponentType,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  JarvisAuthRequiredError,
  runJarvisCore,
  type JarvisCoreResult,
  type WorkspaceSection,
} from "@/lib/jarvisCore";
import {
  getJarvisSessionStatus,
  loginJarvis,
  logoutJarvis,
} from "@/lib/jarvisSession";
import coreStyles from "@/components/JarvisCore.module.css";
import authStyles from "@/components/JarvisAuth.module.css";

type ImmersiveState = "idle" | "loading" | "ready" | "error";
type CoreState = "idle" | "running" | "done" | "error";
type MemoryAccessState = "checking" | "inactive" | "locked" | "unlocked";

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
  const pendingCommandRef = useRef<string | null>(null);
  const [Immersive, setImmersive] = useState<ComponentType | null>(null);
  const [immersiveState, setImmersiveState] = useState<ImmersiveState>("idle");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection | null>(null);
  const [command, setCommand] = useState("");
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [coreState, setCoreState] = useState<CoreState>("idle");
  const [coreResult, setCoreResult] = useState<JarvisCoreResult | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [memoryAccess, setMemoryAccess] = useState<MemoryAccessState>("checking");
  const [authOpen, setAuthOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getJarvisSessionStatus().then((status) => {
      if (!mounted) return;
      if (!status.configured) setMemoryAccess("inactive");
      else if (status.authenticated) setMemoryAccess("unlocked");
      else setMemoryAccess("locked");
    });
    return () => {
      mounted = false;
    };
  }, []);

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
        if (result.core?.authenticated) setMemoryAccess("unlocked");

        if (result.uiAction.type === "open-workspace") {
          setWorkspaceOpen(true);
          setWorkspaceSection(result.uiAction.section ?? null);
        } else if (result.uiAction.type === "open-immersive") {
          await openImmersive();
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof JarvisAuthRequiredError) {
          pendingCommandRef.current = trimmed;
          setMemoryAccess("locked");
          setCoreState("idle");
          setAuthError(null);
          setAuthOpen(true);
          return;
        }
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

  const submitLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (authBusy || password.length < 8) return;
      setAuthBusy(true);
      setAuthError(null);
      try {
        await loginJarvis(password);
        setPassword("");
        setMemoryAccess("unlocked");
        setAuthOpen(false);
        const pending = pendingCommandRef.current;
        pendingCommandRef.current = null;
        if (pending) void executeCommand(pending);
      } catch (error) {
        const code = error instanceof Error ? error.message : "AUTH_FAILED";
        if (code === "IDENTITY_NOT_CONFIGURED") {
          setMemoryAccess("inactive");
          setAuthError("La mémoire personnelle n’est pas encore activée côté serveur.");
        } else if (code === "AUTH_RATE_LIMITED") {
          setAuthError("Trop de tentatives. Réessaie dans quelques minutes.");
        } else {
          setAuthError("Mot de passe incorrect.");
        }
      } finally {
        setAuthBusy(false);
      }
    },
    [authBusy, executeCommand, password],
  );

  const lockMemory = useCallback(async () => {
    setAuthBusy(true);
    await logoutJarvis();
    setAuthBusy(false);
    setMemoryAccess("locked");
    setAuthOpen(false);
  }, []);

  const memoryLabel =
    memoryAccess === "unlocked"
      ? "MÉMOIRE ✓"
      : memoryAccess === "checking"
        ? "MÉMOIRE ·"
        : "MÉMOIRE";

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
        <div className={authStyles.headerActions}>
          <button
            type="button"
            className={`shell-action ${authStyles.memoryButton}`}
            data-state={memoryAccess}
            onClick={() => {
              setAuthError(null);
              setAuthOpen(true);
            }}
          >
            {memoryLabel}
          </button>
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
        </div>
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
              Donne-moi l’objectif. Le Core choisit lui-même la première action utile et peut maintenant utiliser une mémoire personnelle lorsqu’elle est déverrouillée.
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
            {coreResult.core?.memorySaved ? (
              <small className={authStyles.saved}>✓ MÉMOIRE ENREGISTRÉE</small>
            ) : null}
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
            placeholder="Ex. Jarvis, retiens que…"
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

      {authOpen ? (
        <div className={authStyles.backdrop} role="presentation">
          <section className={authStyles.panel} role="dialog" aria-modal="true" aria-label="Mémoire Jarvis">
            <div className={authStyles.panelHeader}>
              <div>
                <div className={authStyles.kicker}>MÉMOIRE PERSONNELLE</div>
                <h2 className={authStyles.title}>
                  {memoryAccess === "unlocked" ? "Mémoire active" : "Déverrouiller Jarvis"}
                </h2>
              </div>
              <button
                type="button"
                className={authStyles.close}
                onClick={() => {
                  pendingCommandRef.current = null;
                  setAuthOpen(false);
                }}
                aria-label="Fermer"
              >
                ×
              </button>
            </div>

            {memoryAccess === "unlocked" ? (
              <>
                <p className={authStyles.copy}>
                  Cette session peut utiliser les projets, décisions et informations que tu demandes explicitement à Jarvis de retenir.
                </p>
                <div className={authStyles.statusLine}>
                  <span className={authStyles.statusDot} aria-hidden="true" />
                  Session personnelle déverrouillée
                </div>
                <button
                  type="button"
                  className={authStyles.secondary}
                  onClick={() => void lockMemory()}
                  disabled={authBusy}
                >
                  VERROUILLER LA MÉMOIRE
                </button>
              </>
            ) : memoryAccess === "inactive" ? (
              <p className={authStyles.copy}>
                La base mémoire est prête dans l’application. Il reste à définir le secret personnel côté Cloudflare pour l’activer sans exposer tes données.
              </p>
            ) : (
              <>
                <p className={authStyles.copy}>
                  Entre ton mot de passe Jarvis. Il restera enregistré uniquement comme session sur cet appareil, pas dans le code public.
                </p>
                <form className={authStyles.form} onSubmit={submitLogin}>
                  <input
                    className={authStyles.input}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Mot de passe Jarvis"
                    aria-label="Mot de passe Jarvis"
                  />
                  <button
                    type="submit"
                    className={authStyles.primary}
                    disabled={authBusy || password.length < 8}
                  >
                    {authBusy ? "VÉRIFICATION…" : "DÉVERROUILLER"}
                  </button>
                </form>
              </>
            )}

            {authError ? <div className={authStyles.error}>{authError}</div> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
