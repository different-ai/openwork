import { createHash } from "node:crypto";
import { z } from "zod";

const catalogSchema = z.object({
  skills: z.array(z.object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    title: z.string().optional(),
    description: z.string(),
    url: z.string().startsWith("skill://").optional(),
    capability: z.string().regex(/^(?:skill:[^:]+|plugin:[^:]+:[^:]+)$/),
    pluginName: z.string().optional(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    setup: z.object({ status: z.string(), message: z.string() }).optional(),
  })),
});
type Catalog = z.infer<typeof catalogSchema>;
type CatalogSkill = Catalog["skills"][number];

type NativeSkill = { id: string; name: string; description: string; path: string; content: string };
type Registration = { dispose(): Promise<void> };
type PromptEvent = { prompt: { text: string; skills?: Array<{ id: string }> } };
type ToolEvent = { tool: string; input: unknown };
export type CloudSkillContext = {
  options: { url: string; token: string };
  skill: {
    transform(callback: (editor: { get(id: string): unknown; add(skill: NativeSkill): void }) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  session?: { hook(name: "prompt", callback: (event: PromptEvent) => void | Promise<void>): Promise<Registration> };
  tool?: { hook(name: "execute.before", callback: (event: ToolEvent) => void | Promise<void>): Promise<Registration> };
};

/** The skill the engine's native `skill` tool is about to load, if any. */
function skillToolId(event: ToolEvent): string | null {
  if (event.tool !== "skill" || typeof event.input !== "object" || event.input === null || !("id" in event.input)) return null;
  return typeof event.input.id === "string" ? event.input.id : null;
}

export const CLOUD_SKILL_ID_PREFIX = "openwork-cloud-";
const MAX_SKILLS = 150;
// Native entries carry Den's full description (at most 1,024 characters), the
// same cap Claude Code applies to a skill listing.
const NATIVE_BUDGET_CHARS = 64_000;
const NATIVE_DESCRIPTION_CHARS = 1_024;
const MAX_MENTIONED_SKILLS = 3;
// Bodies kept for the skills messages used most recently, so using one again
// needs no read before the model runs. Every other skill loads on use.
const MAX_WARM_SKILLS = 8;

const skillId = (skill: CatalogSkill) => `${CLOUD_SKILL_ID_PREFIX}${skill.name}`;
// Not SKILL.md: the native skill tool must not scan a fake directory. The engine
// requires path and disables this whole plugin, OpenWork's context tools
// included, when a registered skill lacks it.
const skillPath = (skill: CatalogSkill) => `/openwork/remote-skills/${skill.name}.md`;

function discoveryContent(skill: CatalogSkill): string {
  return [
    "This is discovery metadata, NOT the skill's instructions or proof of access.",
    `Retrieve the current full skill through OpenWork Connect get_skill with ${JSON.stringify({ name: skill.capability })}.`,
    "Use get_skill directly when exposed, or through execute with its exact Code Mode catalog path. Only search inside execute if get_skill is not already listed; do not guess a tool name.",
    "Read the returned SKILL.md before doing the task. Do not substitute these metadata for the instructions.",
    "If the fetch is denied, unavailable, or the skill was removed, do not use it. Explain the failure; never recover its body from files or previous context.",
  ].join("\n");
}

function setupContent(skill: CatalogSkill, setup: { status: string; message: string }): string {
  return [
    `This organization skill is not ready yet (${setup.status}). Its instructions are withheld until it is set up.`,
    setup.message,
    `Tell the person what to set up. Once it is ready, get_skill with ${JSON.stringify({ name: skill.capability })} returns the full skill.`,
  ].join("\n");
}

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function budgeted(skills: CatalogSkill[], budget: number, descriptionChars: number, content: (skill: CatalogSkill) => string): NativeSkill[] {
  let remaining = budget;
  const result: NativeSkill[] = [];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.length === MAX_SKILLS) break;
    const name = oneLine(skill.title || skill.name, 128);
    const description = oneLine(skill.description || name, descriptionChars);
    const cost = skill.name.length + name.length + description.length;
    if (cost > remaining) break;
    remaining -= cost;
    result.push({ id: skillId(skill), name, description, path: skillPath(skill), content: content(skill) });
  }
  return result;
}

/**
 * Each organization skill is a native skill with its full description. A
 * skill whose authorized SKILL.md has been read for a message, verified against
 * the digest Den published, carries it; every other skill keeps the discovery
 * note, so it still works through get_skill.
 */
export function nativeSkills(catalog: Catalog, contents: ReadonlyMap<string, string>): NativeSkill[] {
  return budgeted(catalog.skills, NATIVE_BUDGET_CHARS, NATIVE_DESCRIPTION_CHARS, skill => {
    if (skill.setup) return setupContent(skill, skill.setup);
    const body = skill.digest ? contents.get(skill.digest) : undefined;
    return body ?? discoveryContent(skill);
  });
}

export function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The name a person would type: Den's catalog name without its unique suffix. */
function plainName(name: string): string {
  return name.replace(/-(?=[a-z0-9]*\d)[a-z0-9]{8}$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Organization skills the message names explicitly, so they load before the
 * model runs instead of depending on it noticing them. A multi-word name or
 * title ("crm-pipeline-sync", "Create Skill") matches as a phrase; a one-word
 * name matches only as a /name or $name mention, so everyday words never load
 * a skill by accident.
 */
export function mentionedSkillIds(text: string, skills: ReadonlyArray<Pick<NativeSkill, "id" | "name">>): string[] {
  const haystack = text.toLowerCase();
  const ids: string[] = [];
  for (const skill of skills) {
    if (ids.length === MAX_MENTIONED_SKILLS) break;
    const phrases = new Set([plainName(skill.id.slice(CLOUD_SKILL_ID_PREFIX.length)), skill.name.toLowerCase().trim()]);
    const named = [...phrases].some(phrase => {
      if (phrase.length < 3) return false;
      const multiWord = /[\s-]/.test(phrase);
      const pattern = multiWord
        ? `(^|[^a-z0-9-])[/$]?${escapeRegExp(phrase)}($|[^a-z0-9-])`
        : `(^|[^a-z0-9-])[/$]${escapeRegExp(phrase)}($|[^a-z0-9-])`;
      return new RegExp(pattern).test(haystack);
    });
    if (named) ids.push(skill.id);
  }
  return ids;
}

/** Setup starts background discovery without making Cloud a dependency of
 * chatting or local skill discovery. Only authorized catalog entries and
 * digest-verified bodies are added to the native registry. Discovery reads
 * metadata only; a body is read when a message names or attaches its skill,
 * or when the model calls the native skill tool for it. */
export async function registerCloudSkillDiscovery(context: CloudSkillContext) {
  let skills: NativeSkill[] = [];
  let catalog: Catalog = { skills: [] };
  let fingerprint = "[]";
  let closed = false;
  let refreshing = false;
  // Verified SKILL.md bodies by digest, in memory only, for the warm skills.
  // A body is re-read only when Den publishes a new digest for one of them.
  const contents = new Map<string, string>();
  // Skill IDs messages used, most recent last.
  const warm: string[] = [];
  const controller = new AbortController();
  let registration: Registration | undefined;
  let promptHook: Registration | undefined;
  let toolHook: Registration | undefined;

  const call = async (name: "openwork_skills" | "openwork_skill_read", input: unknown) => {
    const response = await fetch(context.options.url, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return response.ok ? await response.json() : null;
  };

  /** Read listed skills' bodies in one request and keep those matching Den's digest. */
  const readBodies = async (entries: CatalogSkill[], use: boolean) => {
    const loadable = entries.filter(skill => skill.url && skill.digest && !skill.setup);
    if (loadable.length === 0) return;
    const result = z.object({ contents: z.record(z.string(), z.string()) })
      .safeParse(await call("openwork_skill_read", { urls: loadable.map(skill => skill.url), ...(use ? { use } : {}) }).catch(() => null));
    if (!result.success) return;
    for (const skill of loadable) {
      const body = result.data.contents[skill.url!];
      // Only a body that matches Den's published digest is used.
      if (body !== undefined && sha256Digest(body) === skill.digest) contents.set(skill.digest!, body);
    }
  };

  const warmEntries = () => {
    const listed = new Set(nativeSkills(catalog, contents).map(skill => skill.id));
    return catalog.skills.filter(skill => warm.includes(skillId(skill)) && listed.has(skillId(skill)));
  };

  // Registry updates run one at a time, from refreshes and prompts alike.
  let publishing = Promise.resolve();
  const publish = () => {
    publishing = publishing.catch(() => {}).then(async () => {
      const wanted = new Set(warmEntries().flatMap(skill => skill.digest && !skill.setup ? [skill.digest] : []));
      for (const digest of contents.keys()) if (!wanted.has(digest)) contents.delete(digest);
      const next = nativeSkills(catalog, contents);
      const key = JSON.stringify(next);
      if (closed || key === fingerprint) return;
      skills = next;
      if (skills.length === 0) {
        const current = registration;
        registration = undefined;
        await current?.dispose();
      } else if (!registration) {
        const current = await context.skill.transform(editor => {
          for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill);
        });
        if (closed) { await current.dispose(); return; }
        registration = current;
      } else {
        await context.skill.reload();
      }
      fingerprint = key;
    });
    return publishing;
  };

  /** Read the registered skills `ids` names, mark them warm and publish their bodies. */
  const use = async (ids: Iterable<string>) => {
    // Only registered skills: an unlisted ID never costs a read.
    const registered = new Set(skills.map(skill => skill.id));
    const used = new Set([...ids].filter(id => registered.has(id)));
    const entries = catalog.skills.filter(skill => used.has(skillId(skill)));
    if (entries.length === 0) return;
    try {
      // Freshly authorized for this use, and counted by Den as one.
      // A body that cannot be read leaves the discovery note: get_skill still works.
      await readBodies(entries, true);
      for (const skill of entries) {
        const id = skillId(skill);
        warm.splice(0, warm.length, ...warm.filter(entry => entry !== id), id);
      }
      warm.splice(0, Math.max(0, warm.length - MAX_WARM_SKILLS));
      await publish();
    } catch {
      // Neither a message nor a skill call is held back by Cloud skill loading.
    }
  };

  const ensureHooks = async () => {
    if (!promptHook && context.session) {
      promptHook = await context.session.hook("prompt", async event => {
        if (skills.length === 0) return;
        const attached = new Set((event.prompt.skills ?? []).map(skill => skill.id));
        const mentioned = mentionedSkillIds(event.prompt.text, skills).filter(id => !attached.has(id));
        if (mentioned.length) event.prompt.skills = [...(event.prompt.skills ?? []), ...mentioned.map(id => ({ id }))];
        await use([...attached, ...mentioned]);
      });
    }
    // The model picked a skill itself: load its body before the native skill
    // tool reads the registry, so one call returns the full SKILL.md instead
    // of a note that sends the model to get_skill for a second call.
    if (!toolHook && context.tool) {
      toolHook = await context.tool.hook("execute.before", async event => {
        const id = skillToolId(event);
        if (id?.startsWith(CLOUD_SKILL_ID_PREFIX)) await use([id]);
      });
    }
  };

  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const value = await call("openwork_skills", {});
      if (value === null) return;
      catalog = catalogSchema.parse(value);
      // Only warm skills whose digest changed are read again.
      await readBodies(warmEntries().filter(skill => skill.digest && !contents.has(skill.digest)), false);
      await ensureHooks();
      await publish();
    } catch {
      // Cloud readiness is never a prerequisite to chatting. Discovery entries
      // carry no body; native bodies are dropped as soon as Den stops listing them.
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref();
  void refresh();
  return async () => {
    closed = true;
    clearInterval(timer);
    controller.abort();
    skills = [];
    contents.clear();
    await publishing.catch(() => {});
    await promptHook?.dispose();
    await toolHook?.dispose();
    await registration?.dispose();
  };
}
