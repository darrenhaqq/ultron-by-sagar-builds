import type { JarvisIdentity } from "./auth";
import { ensureSchema, type DbEnv } from "./db";

export type MemoryEnv = DbEnv;

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
  projectName?: string | null;
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
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

async function resolveProjectId(
  projectId: string | null | undefined,
  projectName: string | null | undefined,
  env: MemoryEnv,
): Promise<string | null> {
  const db = await ensureSchema(env);
  if (projectId) {
    const existing = await db
      .prepare("SELECT id FROM jarvis_projects WHERE id = ?")
      .bind(projectId)
      .first<{ id: string }>();
    if (existing?.id) return existing.id;
  }

  const cleanName = projectName?.trim();
  if (!cleanName) return null;
  const normalizedName = normalize(cleanName);
  if (!normalizedName) return null;

  const existing = await db
    .prepare("SELECT id FROM jarvis_projects WHERE normalized_name = ?")
    .bind(normalizedName)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;

  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO jarvis_projects (id, name, normalized_name, status, priority) VALUES (?, ?, ?, 'active', 50)",
    )
    .bind(id, cleanName.slice(0, 180), normalizedName.slice(0, 180))
    .run();
  return id;
}

export async function retrieveMemoryContext(
  command: string,
  identity: JarvisIdentity,
  env: MemoryEnv,
): Promise<MemoryContext> {
  void identity;
  const db = await ensureSchema(env);
  const [projectsResult, memoriesResult] = await Promise.all([
    db
      .prepare(
        "SELECT id, name, summary, status, priority, updated_at FROM jarvis_projects WHERE status = 'active' ORDER BY priority DESC, updated_at DESC LIMIT 20",
      )
      .all<ProjectItem>(),
    db
      .prepare(
        "SELECT id, project_id, kind, title, content, importance, updated_at FROM jarvis_memories ORDER BY importance DESC, updated_at DESC LIMIT 60",
      )
      .all<MemoryItem>(),
  ]);

  const projects = projectsResult.results || [];
  const memories = memoriesResult.results || [];
  const words = keywords(command);

  const scoredProjects = projects
    .map((project) => ({
      project,
      score:
        relevance(words, project.name) * 2 +
        relevance(words, project.summary || "") +
        Number(project.priority) / 100,
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
        Number(memory.importance) / 100,
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
  void identity;
  const db = await ensureSchema(env);
  const importance = Math.max(0, Math.min(100, Math.round(input.importance ?? 60)));
  const projectId = await resolveProjectId(input.projectId, input.projectName, env);
  const id = crypto.randomUUID();
  const title = input.title.trim().slice(0, 180);
  const content = input.content.trim().slice(0, 4000);

  await db
    .prepare(
      "INSERT INTO jarvis_memories (id, project_id, kind, title, content, importance, source) VALUES (?, ?, ?, ?, ?, ?, 'explicit')",
    )
    .bind(id, projectId, input.kind, title, content, importance)
    .run();

  const memory = await db
    .prepare(
      "SELECT id, project_id, kind, title, content, importance, updated_at FROM jarvis_memories WHERE id = ?",
    )
    .bind(id)
    .first<MemoryItem>();

  if (!memory) throw new Error("MEMORY_WRITE_EMPTY");
  return memory;
}

export async function listProjects(
  identity: JarvisIdentity,
  env: MemoryEnv,
): Promise<ProjectItem[]> {
  void identity;
  const db = await ensureSchema(env);
  const result = await db
    .prepare(
      "SELECT id, name, summary, status, priority, updated_at FROM jarvis_projects ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, priority DESC, updated_at DESC LIMIT 100",
    )
    .all<ProjectItem>();
  return result.results || [];
}

export async function listRecentMemories(
  identity: JarvisIdentity,
  env: MemoryEnv,
): Promise<MemoryItem[]> {
  void identity;
  const db = await ensureSchema(env);
  const result = await db
    .prepare(
      "SELECT id, project_id, kind, title, content, importance, updated_at FROM jarvis_memories ORDER BY updated_at DESC LIMIT 100",
    )
    .all<MemoryItem>();
  return result.results || [];
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
        .map((memory) => `- [${memory.kind}] ${memory.title}: ${memory.content}`)
        .join("\n")
    : "- Aucun souvenir pertinent";

  return `PROJETS PERTINENTS\n${projects}\n\nMÉMOIRE PERTINENTE\n${memories}`;
}
