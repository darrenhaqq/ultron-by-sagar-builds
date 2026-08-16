import type { JarvisIdentity } from "./auth";

export type MemoryEnv = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
};

export type MemoryKind =
  | "decision"
  | "preference"
  | "fact"
  | "commitment"
  | "procedure"
  | "note";

export type MemoryItem = {
  id: string;
  project_id: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  updated_at: string;
};

export type ProjectItem = {
  id: string;
  name: string;
  summary: string | null;
  status: "active" | "paused" | "completed" | "archived";
  priority: number;
  updated_at: string;
};

export type MemoryContext = {
  projects: ProjectItem[];
  memories: MemoryItem[];
};

export type SaveMemoryInput = {
  kind: MemoryKind;
  title: string;
  content: string;
  importance?: number;
  projectId?: string | null;
};

function apiBase(env: MemoryEnv): string {
  return `${env.SUPABASE_URL!.replace(/\/$/, "")}/rest/v1`;
}

function headers(env: MemoryEnv, identity: JarvisIdentity): HeadersInit {
  return {
    apikey: env.SUPABASE_PUBLISHABLE_KEY!,
    authorization: `Bearer ${identity.accessToken}`,
    "content-type": "application/json",
  };
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "alors", "avec", "avoir", "dans", "des", "elle", "elles", "est", "faire",
  "fais", "il", "ils", "jarvis", "les", "leur", "mais", "mes", "mon", "nous",
  "pour", "que", "quel", "quelle", "quels", "quelles", "quoi", "sur", "tes", "ton",
  "une", "vous", "veux", "veut", "comment", "ou", "suis", "sommes", "etre", "moi",
]);

function keywords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function relevance(commandWords: Set<string>, text: string): number {
  if (!commandWords.size) return 0;
  const candidateWords = keywords(text);
  let hits = 0;
  for (const word of commandWords) {
    if (candidateWords.has(word)) hits += 1;
  }
  return hits / Math.max(1, commandWords.size);
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`MEMORY_HTTP_${response.status}`);
  }
  return (await response.json()) as T;
}

export async function retrieveMemoryContext(
  command: string,
  identity: JarvisIdentity,
  env: MemoryEnv,
): Promise<MemoryContext> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { projects: [], memories: [] };
  }

  const [projectsResponse, memoriesResponse] = await Promise.all([
    fetch(
      `${apiBase(env)}/jarvis_projects?select=id,name,summary,status,priority,updated_at&status=eq.active&order=priority.desc,updated_at.desc&limit=20`,
      { headers: headers(env, identity) },
    ),
    fetch(
      `${apiBase(env)}/jarvis_memories?select=id,project_id,kind,title,content,importance,updated_at&order=importance.desc,updated_at.desc&limit=60`,
      { headers: headers(env, identity) },
    ),
  ]);

  const [projects, memories] = await Promise.all([
    readJson<ProjectItem[]>(projectsResponse),
    readJson<MemoryItem[]>(memoriesResponse),
  ]);

  const words = keywords(command);
  const scoredProjects = projects
    .map((project) => ({
      project,
      score:
        relevance(words, project.name) * 2 +
        relevance(words, project.summary || "") +
        project.priority / 100,
    }))
    .sort((a, b) => b.score - a.score);

  const selectedProjects = scoredProjects
    .filter((entry, index) => entry.score > 0.02 || index < 4)
    .slice(0, 6)
    .map((entry) => entry.project);

  const selectedProjectIds = new Set(selectedProjects.map((project) => project.id));
  const scoredMemories = memories
    .map((memory) => ({
      memory,
      score:
        relevance(words, `${memory.title} ${memory.content}`) * 3 +
        (memory.project_id && selectedProjectIds.has(memory.project_id) ? 0.5 : 0) +
        memory.importance / 100,
    }))
    .sort((a, b) => b.score - a.score);

  const selectedMemories = scoredMemories
    .filter((entry, index) => entry.score > 0.05 || index < 5)
    .slice(0, 10)
    .map((entry) => entry.memory);

  return { projects: selectedProjects, memories: selectedMemories };
}

export async function saveMemory(
  input: SaveMemoryInput,
  identity: JarvisIdentity,
  env: MemoryEnv,
): Promise<MemoryItem> {
  const importance = Math.max(0, Math.min(100, Math.round(input.importance ?? 60)));
  const response = await fetch(`${apiBase(env)}/jarvis_memories`, {
    method: "POST",
    headers: {
      ...headers(env, identity),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      owner_id: identity.id,
      project_id: input.projectId || null,
      kind: input.kind,
      title: input.title.slice(0, 180),
      content: input.content.slice(0, 4000),
      importance,
    }),
  });

  const rows = await readJson<MemoryItem[]>(response);
  if (!rows[0]) throw new Error("MEMORY_WRITE_EMPTY");
  return rows[0];
}

export function memoryContextForPrompt(context: MemoryContext): string {
  if (!context.projects.length && !context.memories.length) {
    return "Aucune mémoire pertinente n'a été retrouvée pour cette demande.";
  }

  const projects = context.projects.length
    ? context.projects
        .map(
          (project) =>
            `- Projet: ${project.name} | priorité ${project.priority} | ${project.summary || "sans résumé"}`,
        )
        .join("\n")
    : "- Aucun projet pertinent";

  const memories = context.memories.length
    ? context.memories
        .map(
          (memory) =>
            `- [${memory.kind}] ${memory.title}: ${memory.content}`,
        )
        .join("\n")
    : "- Aucun souvenir pertinent";

  return `PROJETS PERTINENTS\n${projects}\n\nMÉMOIRE PERTINENTE\n${memories}`;
}
