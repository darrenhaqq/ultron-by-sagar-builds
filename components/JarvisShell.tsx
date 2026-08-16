"use client";

import {
  type ComponentType,
  type FormEvent,
  useCallback,
  useState,
} from "react";

type ImmersiveState = "idle" | "loading" | "ready" | "error";
type WorkspaceSection = "projects" | "files" | "ideas" | "research" | null;

const WORKSPACE_ITEMS: Array<{
  id: Exclude<WorkspaceSection, null>;
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
  const [Immersive, setImmersive] = useState<ComponentType | null>(null);
  const [immersiveState, setImmersiveState] = useState<ImmersiveState>("idle");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>(null);
  const [command, setCommand] = useState("");
  const [lastCommand, setLastCommand] = useState<string | null>(null);

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

  const submitCommand = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = command.trim();
      if (!trimmed) return;
      setLastCommand(trimmed);
      setCommand("");
    },
    [command],
  );

  return (
    <main className="jarvis-shell">
      <header className="shell-header">
        <div>
          <div className="shell-kicker">J.A.R.V.I.S.</div>
          <div className="shell-status">
            <span className="status-dot" aria-hidden="true" /> MODE LÉGER
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
                    ? "Le contenu réel sera fourni par Jarvis Core."
                    : "Sélectionne une zone. Rien de lourd n’est chargé tant que tu ne l’ouvres pas."}
                </div>
              </div>
            </div>

            {workspaceSection ? (
              <div className="workspace-detail">
                <div className="workspace-node workspace-node-active" aria-hidden="true" />
                <p>
                  Cette vue est déjà séparée du moteur 3D. Elle pourra recevoir les données du Core puis être affichée en cartes légères ou dans l’espace immersif.
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
            <div className="light-orb" aria-hidden="true">
              <span />
            </div>
            <h1>Que dois-je faire pour toi&nbsp;?</h1>
            <p>
              Le client léger est prêt. L’intelligence, la mémoire et les outils seront connectés au Jarvis Core sans alourdir le téléphone.
            </p>

            {lastCommand ? (
              <div className="local-command">
                <span>COMMANDE CAPTURÉE</span>
                <strong>{lastCommand}</strong>
                <small>Traitement IA non connecté dans cette étape.</small>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <div className="shell-bottom">
        <form className="command-bar" onSubmit={submitCommand}>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Demande quelque chose à Jarvis…"
            aria-label="Commande Jarvis"
          />
          <button type="submit" disabled={!command.trim()}>
            ENVOYER
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
