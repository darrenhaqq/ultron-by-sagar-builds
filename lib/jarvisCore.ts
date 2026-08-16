import {
  JARVIS_CORE_URL,
  clearJarvisSessionToken,
  getJarvisSessionToken,
} from "@/lib/jarvisSession";

export type WorkspaceSection = "projects" | "files" | "ideas" | "research";

export type JarvisUiAction =
  | { type: "open-workspace"; section?: WorkspaceSection }
  | { type: "open-immersive" }
  | { type: "none" };

export interface JarvisPlanStep {
  id: string;
  label: string;
  status: "planned" | "done" | "blocked";
}

export interface JarvisCoreMeta {
  authenticated?: boolean;
  memoryLoaded?: boolean;
  memoryRequested?: boolean;
  memorySaved?: boolean;
}

export interface JarvisCoreResult {
  runId: string;
  mode: "local" | "remote";
  objective: string;
  answer: string;
  confidence: number;
  uiAction: JarvisUiAction;
  steps: JarvisPlanStep[];
  needsRemoteCore: boolean;
  core?: JarvisCoreMeta;
}

interface RemoteCoreResponse {
  objective?: string;
  answer?: string;
  confidence?: number;
  uiAction?: JarvisUiAction;
  steps?: JarvisPlanStep[];
  core?: JarvisCoreMeta;
}

export class JarvisAuthRequiredError extends Error {
  constructor() {
    super("JARVIS_AUTH_REQUIRED");
    this.name = "JarvisAuthRequiredError";
  }
}

function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function newRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function localPlan(command: string): JarvisCoreResult {
  const text = normalize(command);
  const runId = newRunId();

  if (
    hasAny(text, [
      "vue immersive",
      "mode immersif",
      "ouvre l orbe",
      "montre l orbe",
      "affiche l orbe",
    ])
  ) {
    return {
      runId,
      mode: "local",
      objective: "Ouvrir l’espace immersif de Jarvis",
      answer: "J’ouvre la vue immersive.",
      confidence: 0.96,
      uiAction: { type: "open-immersive" },
      needsRemoteCore: false,
      steps: [
        { id: "understand", label: "Comprendre l’objectif", status: "done" },
        { id: "ui", label: "Ouvrir la vue immersive", status: "done" },
      ],
    };
  }

  const workspaceMatchers: Array<{
    section: WorkspaceSection;
    words: string[];
    objective: string;
    answer: string;
  }> = [
    {
      section: "projects",
      words: ["projet", "projets", "travaux", "priorites", "priorite"],
      objective: "Explorer les projets et priorités",
      answer: "J’ouvre l’espace Projets. Le Core distant pourra y injecter tes données réelles.",
    },
    {
      section: "files",
      words: ["fichier", "fichiers", "document", "documents", "dossier", "dossiers"],
      objective: "Explorer les fichiers et documents",
      answer: "J’ouvre l’espace Fichiers. Les sources réelles seront utilisées lorsqu’elles seront connectées au Core.",
    },
    {
      section: "ideas",
      words: ["idee", "idees", "piste", "pistes", "brainstorm"],
      objective: "Explorer les idées et pistes de travail",
      answer: "J’ouvre l’espace Idées pour organiser et explorer les pistes.",
    },
    {
      section: "research",
      words: ["recherche", "chercher", "cherche", "internet", "web", "source", "sources"],
      objective: "Préparer une recherche",
      answer: "J’ouvre l’espace Recherche. L’accès web réel sera exécuté par le Core distant, pas par le téléphone.",
    },
  ];

  for (const matcher of workspaceMatchers) {
    if (hasAny(text, matcher.words)) {
      return {
        runId,
        mode: "local",
        objective: matcher.objective,
        answer: matcher.answer,
        confidence: 0.88,
        uiAction: { type: "open-workspace", section: matcher.section },
        needsRemoteCore: matcher.section === "files" || matcher.section === "research",
        steps: [
          { id: "understand", label: "Comprendre l’objectif", status: "done" },
          { id: "route", label: `Choisir l’espace ${matcher.section}`, status: "done" },
          {
            id: "data",
            label: "Récupérer les données réelles",
            status:
              matcher.section === "files" || matcher.section === "research"
                ? "blocked"
                : "planned",
          },
        ],
      };
    }
  }

  if (hasAny(text, ["aujourd hui", "journee", "urgent", "urgence", "a faire", "agenda"])) {
    return {
      runId,
      mode: "local",
      objective: "Préparer les priorités de la journée",
      answer:
        "J’ai compris que tu veux un briefing de ta journée. Pour le faire correctement, il faut encore connecter l’agenda et les tâches au Core.",
      confidence: 0.91,
      uiAction: { type: "open-workspace", section: "projects" },
      needsRemoteCore: true,
      steps: [
        { id: "understand", label: "Comprendre l’objectif", status: "done" },
        { id: "calendar", label: "Consulter l’agenda", status: "blocked" },
        { id: "tasks", label: "Consulter les tâches", status: "blocked" },
        { id: "memory", label: "Récupérer les projets actifs", status: "planned" },
        { id: "brief", label: "Construire le briefing", status: "planned" },
      ],
    };
  }

  return {
    runId,
    mode: "local",
    objective: "Comprendre et exécuter la demande",
    answer:
      "J’ai reçu la demande. Le noyau local ne doit pas inventer une réponse : cette requête nécessite le moteur IA du Jarvis Core.",
    confidence: 0.55,
    uiAction: { type: "none" },
    needsRemoteCore: true,
    steps: [
      { id: "understand", label: "Analyser la demande", status: "done" },
      { id: "reason", label: "Raisonner avec le moteur IA", status: "blocked" },
      { id: "tools", label: "Choisir et exécuter les outils", status: "planned" },
    ],
  };
}

async function runRemote(
  command: string,
  signal?: AbortSignal,
): Promise<JarvisCoreResult | null> {
  try {
    const token = getJarvisSessionToken();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${JARVIS_CORE_URL.replace(/\/$/, "")}/v1/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command, client: "jarvis-web-v1" }),
      signal,
    });

    if (response.status === 401) {
      clearJarvisSessionToken();
      throw new JarvisAuthRequiredError();
    }
    if (!response.ok) return null;

    const payload = (await response.json()) as RemoteCoreResponse;
    if (!payload.answer || !payload.objective) return null;

    return {
      runId: newRunId(),
      mode: "remote",
      objective: payload.objective,
      answer: payload.answer,
      confidence: payload.confidence ?? 0.85,
      uiAction: payload.uiAction ?? { type: "none" },
      steps: payload.steps ?? [],
      needsRemoteCore: false,
      core: payload.core,
    };
  } catch (error) {
    if (error instanceof JarvisAuthRequiredError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

export async function runJarvisCore(
  command: string,
  signal?: AbortSignal,
): Promise<JarvisCoreResult> {
  const remote = await runRemote(command, signal);
  if (remote) return remote;
  return localPlan(command);
}
