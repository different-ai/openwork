/**
 * Creator Mode presets: a saved runtime composition for a workspace — skill
 * contents, plugin specs, MCP server configs and commands — stored locally and
 * portable via export/import. Applying a preset replays those writes against a
 * workspace through the normal openwork-server surfaces, the same way the
 * Personalización page writes each piece one by one.
 *
 * Note: MCP configs may contain credentials. Presets live in this browser's
 * localStorage and export as plain JSON — review them before sharing.
 */

export type CreatorPresetMcp = {
  name: string;
  config: Record<string, unknown>;
  /** Intent templates ship MCP slots the user must fill before applying. */
  needsConfig?: boolean;
};

export type CreatorPreset = {
  id: string;
  name: string;
  createdAt: number;
  workspaceId: string;
  /** For intention templates: what this composition is for. */
  intent?: string;
  skills: Array<{ name: string; content: string; description?: string }>;
  plugins: Array<{ spec: string }>;
  mcp: CreatorPresetMcp[];
  commands: Array<{ name: string; template: string; description?: string; agent?: string; model?: string | null; subtask?: boolean }>;
};

const STORAGE_KEY = "openwork.creatorPresets.v1";

function readAll(): CreatorPreset[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CreatorPreset =>
      Boolean(item) && typeof item === "object"
      && typeof (item as CreatorPreset).id === "string"
      && typeof (item as CreatorPreset).name === "string"
      && Array.isArray((item as CreatorPreset).skills));
  } catch {
    return [];
  }
}

function writeAll(presets: CreatorPreset[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Storage unavailable: presets stay in memory for this session only.
  }
}

export function listPresets(): CreatorPreset[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function savePreset(preset: CreatorPreset): CreatorPreset[] {
  const next = [preset, ...readAll().filter((item) => item.id !== preset.id)];
  writeAll(next);
  return next;
}

export function deletePreset(id: string): CreatorPreset[] {
  const next = readAll().filter((item) => item.id !== id);
  writeAll(next);
  return next;
}

/** Summaries for the apply-confirm dialog: what a preset would write. */
export function describePreset(preset: CreatorPreset): string {
  const parts = [
    `${preset.skills.length} skill${preset.skills.length === 1 ? "" : "s"}`,
    `${preset.plugins.length} plugin${preset.plugins.length === 1 ? "" : "s"}`,
    `${preset.mcp.length} MCP`,
    `${preset.commands.length} comando${preset.commands.length === 1 ? "" : "s"}`,
  ];
  return parts.join(", ");
}

/**
 * What applying this preset would actually do, checked BEFORE any write:
 * MCP slots still needing configuration are listed separately from hard
 * problems, and the apply flow skips them instead of writing empty configs.
 */
export function validatePreset(preset: CreatorPreset): { problems: string[]; unconfiguredMcp: string[] } {
  const problems: string[] = [];
  const unconfiguredMcp: string[] = [];
  for (const server of preset.mcp) {
    const empty = !server.config || Object.keys(server.config).length === 0;
    if (server.needsConfig || empty) unconfiguredMcp.push(server.name);
  }
  if (preset.skills.some((skill) => !skill.content.trim())) {
    problems.push("hay skills con contenido vacío");
  }
  if (preset.commands.some((command) => !command.template.trim())) {
    problems.push("hay comandos con plantilla vacía");
  }
  return { problems, unconfiguredMcp };
}

function skillDocument(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/**
 * Intention templates: the DSH "home server agent" idea — a composition
 * designed for a purpose, with fully written skills and MCP slots the user
 * fills (or the agentic builder completes) before applying.
 */
export const INTENT_TEMPLATES: Array<{ id: string; label: string; description: string; build: () => CreatorPreset }> = [
  {
    id: "intent-home-server",
    label: "Operador de servidor doméstico",
    description: "Salud del servidor, contenedores y disco; comando /estado para un chequeo rápido.",
    build: () => ({
      id: crypto.randomUUID(),
      name: "Operador de servidor doméstico",
      intent: "Gestionar y vigilar un servidor doméstico desde el agente.",
      createdAt: Date.now(),
      workspaceId: "",
      skills: [
        {
          name: "servidor-salud",
          description: "Chequeo de salud del servidor: contenedores, disco, memoria y logs recientes.",
          content: skillDocument(
            "servidor-salud",
            "Chequeo de salud del servidor: contenedores, disco, memoria y logs recientes.",
            [
              "# Salud del servidor",
              "",
              "Cuando el usuario pida el estado del servidor o detectes un problema de infraestructura:",
              "",
              "1. `docker ps -a --format '{{.Names}}\\t{{.Status}}'` — lista contenedores y marca los caídos.",
              "2. `df -h` y `free -h` — disco y memoria; avisa si el disco supera 85%.",
              "3. `docker logs --tail 50 <contenedor>` para cada contenedor reiniciado recientemente.",
              "4. Resume en una tabla: servicio, estado, problema detectado, acción recomendada.",
              "",
              "No reinicies nada sin pedir confirmación explícita.",
            ].join("\n"),
          ),
        },
      ],
      plugins: [],
      mcp: [],
      commands: [
        {
          name: "estado",
          template: "Ejecuta la skill servidor-salud y dame el resumen del estado del servidor.",
          description: "Chequeo rápido de salud del servidor",
        },
      ],
    }),
  },
  {
    id: "intent-pr-reviewer",
    label: "Revisor de pull requests",
    description: "Revisión con estándar del equipo; requiere el conector MCP de GitHub que configuras tú.",
    build: () => ({
      id: crypto.randomUUID(),
      name: "Revisor de pull requests",
      intent: "Revisar PRs con un estándar consistente y comentarios accionables.",
      createdAt: Date.now(),
      workspaceId: "",
      skills: [
        {
          name: "revision-pr",
          description: "Estándar de revisión de PRs: corrección, seguridad, legibilidad y tests.",
          content: skillDocument(
            "revision-pr",
            "Revisa un pull request con el estándar del equipo y deja comentarios accionables.",
            [
              "# Revisión de pull requests",
              "",
              "Para cada PR:",
              "",
              "1. Lee la descripción y los cambios diff a diff; clasifica cada cambio: corrección / seguridad / legibilidad / tests.",
              "2. Corrección: busca casos borde, manejo de errores y efectos secundarios no anunciados.",
              "3. Seguridad: entradas no validadas, secretos en el código, permisos ampliados de más.",
              "4. Legibilidad: nombres, dead code y duplicación evidente.",
              "5. Tests: ¿cada rama nueva tiene al menos un test que la cubre? Si no, propón el test mínimo.",
              "",
              "Entrega: veredicto (aprobar / pedir cambios), lista priorizada de comentarios con ejemplos concretos del diff, y lo que está bien hecho.",
            ].join("\n"),
          ),
        },
      ],
      plugins: [],
      mcp: [
        { name: "github", config: {}, needsConfig: true },
      ],
      commands: [
        {
          name: "revisar-pr",
          template: "Revisa el PR $ARGUMENTS siguiendo la skill revision-pr y dame el veredicto con comentarios priorizados.",
          description: "Revisa un pull request con el estándar del equipo",
        },
      ],
    }),
  },
  {
    id: "intent-report-watcher",
    label: "Vigilante de informes",
    description: "Genera informes periódicos del proyecto en context/informes/; /informe bajo demanda.",
    build: () => ({
      id: crypto.randomUUID(),
      name: "Vigilante de informes",
      intent: "Mantener informes periódicos del estado del proyecto en context/informes/.",
      createdAt: Date.now(),
      workspaceId: "",
      skills: [
        {
          name: "informe-proyecto",
          description: "Genera un informe del estado del proyecto y lo guarda en context/informes/.",
          content: skillDocument(
            "informe-proyecto",
            "Genera un informe del estado del proyecto y lo guarda en context/informes/.",
            [
              "# Informe de proyecto",
              "",
              "1. Revisa los ficheros modificados en las últimas 24 horas (`git status --short`, `git log --since`).",
              "2. Resume: qué cambió, qué está a medio hacer, riesgos abiertos.",
              "3. Guarda el informe en `context/informes/YYYY-MM-DD-informe.md` (crea la carpeta si no existe).",
              "4. Mantén el formato: Resumen / Cambios / Riesgos / Siguiente paso.",
            ].join("\n"),
          ),
        },
      ],
      plugins: [],
      mcp: [],
      commands: [
        {
          name: "informe",
          template: "Genera el informe del proyecto con la skill informe-proyecto y guarda el fichero de hoy.",
          description: "Informe del estado del proyecto",
        },
      ],
    }),
  },
];
