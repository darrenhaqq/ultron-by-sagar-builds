type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type Env = {
  AI: AiBinding;
  ALLOWED_ORIGIN: string;
  JARVIS_MODEL: string;
};

type WorkspaceSection = "projects" | "files" | "ideas" | "research";
type UiAction =
  | { type: "open-workspace"; section?: WorkspaceSection }
  | { type: "open-immersive" }
  | { type: "none" };

type ModelStep = {
  label: string;
  status: "done" | "planned" | "blocked";
};

type ModelDecision = {
  objective: string;
  answer: string;
  confidence: number;
  action: "none" | "open-workspace" | "open-immersive";
  section: WorkspaceSection | "none";
  steps: ModelStep[];
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string" },
    answer: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    action: {
      type: "string",
      enum: ["none", "open-workspace", "open-immersive"],
    },
    section: {
      type: "string",
      enum: ["projects", "files", "ideas", "research", "none"],
    },
    steps: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          status: {
            type: "string",
            enum: ["done", "planned", "blocked"],
          },
        },
        required: ["label", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["objective", "answer", "confidence", "action", "section", "steps"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `Tu es Jarvis Core V1, le cerveau d'un assistant personnel.

Règles absolues :
- Comprends d'abord l'objectif réel de l'utilisateur, pas seulement les mots-clés.
- Réponds en français sauf si l'utilisateur demande une autre langue.
- Sois concis, utile, calme et orienté action.
- Ne révèle jamais de chaîne de pensée interne. Les étapes retournées sont seulement un plan opérationnel bref.
- Tu peux raisonner et répondre avec tes connaissances générales.
- Aucun outil externe réel n'est encore connecté à cette version du Core.
- Tu ne dois donc JAMAIS affirmer avoir lu un email, un calendrier, un fichier privé, une base de données, Internet, une position GPS ou une information temps réel.
- Si l'objectif exige une donnée externe non disponible, explique clairement ce qui manque et marque l'étape correspondante comme blocked.
- Choisis open-workspace uniquement si une vue de travail aide réellement l'utilisateur.
- Utilise section=projects pour projets/priorités/tâches, files pour documents/fichiers, ideas pour idées/brainstorm, research pour recherche/sources.
- Choisis open-immersive seulement si l'utilisateur demande explicitement l'orbe, la 3D ou la vue immersive.
- Pour une question générale qui ne nécessite aucun outil, réponds directement et action=none.
- N'invente jamais une action exécutée.
`;

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGIN || "https://darrenhaqq.github.io";
  const selected = origin === allowed ? allowed : allowed;
  return {
    "Access-Control-Allow-Origin": selected,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  request: Request,
  env: Env,
): Response {
  const headers = new Headers(corsHeaders(request.headers.get("Origin"), env));
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function toUiAction(decision: ModelDecision): UiAction {
  if (decision.action === "open-immersive") return { type: "open-immersive" };
  if (decision.action === "open-workspace") {
    if (decision.section === "none") return { type: "open-workspace" };
    return { type: "open-workspace", section: decision.section };
  }
  return { type: "none" };
}

function extractDecision(raw: unknown): ModelDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const response = (raw as { response?: unknown }).response;
  const candidate = response && typeof response === "object" ? response : raw;
  if (!candidate || typeof candidate !== "object") return null;

  const value = candidate as Partial<ModelDecision>;
  if (
    typeof value.objective !== "string" ||
    typeof value.answer !== "string" ||
    typeof value.confidence !== "number" ||
    !Array.isArray(value.steps)
  ) {
    return null;
  }

  const actions = new Set(["none", "open-workspace", "open-immersive"]);
  const sections = new Set(["projects", "files", "ideas", "research", "none"]);
  if (!actions.has(String(value.action)) || !sections.has(String(value.section))) {
    return null;
  }

  return value as ModelDecision;
}

async function handleRun(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 16_384) {
    return jsonResponse({ error: "REQUEST_TOO_LARGE" }, 413, request, env);
  }

  let body: { command?: unknown; client?: unknown };
  try {
    body = (await request.json()) as { command?: unknown; client?: unknown };
  } catch {
    return jsonResponse({ error: "INVALID_JSON" }, 400, request, env);
  }

  if (typeof body.command !== "string") {
    return jsonResponse({ error: "COMMAND_REQUIRED" }, 400, request, env);
  }

  const command = body.command.trim();
  if (!command) return jsonResponse({ error: "COMMAND_REQUIRED" }, 400, request, env);
  if (command.length > 4_000) {
    return jsonResponse({ error: "COMMAND_TOO_LONG" }, 413, request, env);
  }

  const model = env.JARVIS_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast";

  try {
    const raw = await env.AI.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: command },
      ],
      temperature: 0.2,
      max_tokens: 700,
      response_format: {
        type: "json_schema",
        json_schema: OUTPUT_SCHEMA,
      },
    });

    const decision = extractDecision(raw);
    if (!decision) {
      return jsonResponse({ error: "MODEL_OUTPUT_INVALID" }, 502, request, env);
    }

    const steps = decision.steps.slice(0, 6).map((step, index) => ({
      id: `step-${index + 1}`,
      label: step.label,
      status: step.status,
    }));

    return jsonResponse(
      {
        objective: decision.objective,
        answer: decision.answer,
        confidence: Math.max(0, Math.min(1, decision.confidence)),
        uiAction: toUiAction(decision),
        steps,
        core: {
          provider: "cloudflare-workers-ai",
          model,
          toolsConnected: 0,
        },
      },
      200,
      request,
      env,
    );
  } catch (error) {
    console.error("Jarvis AI failure", error);
    return jsonResponse(
      { error: "AI_UNAVAILABLE", message: "Le moteur IA est temporairement indisponible." },
      503,
      request,
      env,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get("Origin"), env),
      });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse(
        {
          status: "ok",
          service: "jarvis-core",
          version: "0.1.0",
          ai: true,
          toolsConnected: 0,
        },
        200,
        request,
        env,
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/run") {
      return handleRun(request, env);
    }

    return jsonResponse({ error: "NOT_FOUND" }, 404, request, env);
  },
};
