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
    files: z.array(z.object({ path: z.string(), digest: z.string() })).optional(),
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

function skillToolId(event: ToolEvent): string | null {
  if (event.tool !== "skill" || typeof event.input !== "object" || event.input === null || !("id" in event.input)) return null;
  return typeof event.input.id === "string" ? event.input.id : null;
}

export const CLOUD_SKILL_ID_PREFIX = "openwork-cloud-";
const MAX_SKILLS = 150;
const NATIVE_BUDGET_CHARS = 64_000;
const NATIVE_DESCRIPTION_CHARS = 1_024;
const MAX_MENTIONED_SKILLS = 3;
const MAX_WARM_SKILLS = 8;

const skillId = (skill: CatalogSkill) => `${CLOUD_SKILL_ID_PREFIX}${skill.name}`;
const skillPath = (skill: CatalogSkill) => `/openwork/remote-skills/${skill.name}.md`;

const folderKey = (skill: CatalogSkill) => skill.digest && skill.files?.length
  ? JSON.stringify([skill.name, skill.digest, skill.files.map(file => [file.path, file.digest])])
  : null;

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

export function nativeSkills(catalog: Catalog, contents: ReadonlyMap<string, string>, folders: ReadonlyMap<string, string> = new Map()): NativeSkill[] {
  const listed = budgeted(catalog.skills, NATIVE_BUDGET_CHARS, NATIVE_DESCRIPTION_CHARS, skill => {
    if (skill.setup) return setupContent(skill, skill.setup);
    const body = skill.digest ? contents.get(skill.digest) : undefined;
    return body ?? discoveryContent(skill);
  });
  const byId = new Map(catalog.skills.map(skill => [skillId(skill), skill]));
  return listed.map(native => {
    const skill = byId.get(native.id);
    const key = skill && !skill.setup && skill.digest && contents.has(skill.digest) ? folderKey(skill) : null;
    const folder = key ? folders.get(key) : undefined;
    return folder ? { ...native, path: folder } : native;
  });
}

export function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function plainName(name: string): string {
  return name.replace(/-(?=[a-z0-9]*\d)[a-z0-9]{8}$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export async function registerCloudSkillDiscovery(context: CloudSkillContext) {
  let skills: NativeSkill[] = [];
  let catalog: Catalog = { skills: [] };
  let fingerprint = "[]";
  let closed = false;
  let refreshing = false;
  const contents = new Map<string, string>();
  const folders = new Map<string, string>();
  const warm: string[] = [];
  const controller = new AbortController();
  let registration: Registration | undefined;
  let promptHook: Registration | undefined;
  let toolHook: Registration | undefined;

  const call = async (name: "openwork_skills" | "openwork_skill_read" | "openwork_skill_folder", input: unknown) => {
    const response = await fetch(context.options.url, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return response.ok ? await response.json() : null;
  };

  const readBodies = async (entries: CatalogSkill[], use: boolean) => {
    const loadable = entries.filter(skill => skill.url && skill.digest && !skill.setup);
    if (loadable.length === 0) return;
    const result = z.object({ contents: z.record(z.string(), z.string()) })
      .safeParse(await call("openwork_skill_read", { urls: loadable.map(skill => skill.url), ...(use ? { use } : {}) }).catch(() => null));
    if (!result.success) return;
    for (const skill of loadable) {
      const body = result.data.contents[skill.url!];
      if (body !== undefined && sha256Digest(body) === skill.digest) contents.set(skill.digest!, body);
    }
  };

  const ensureFolders = async (entries: CatalogSkill[]) => {
    for (const skill of entries) {
      const key = folderKey(skill);
      if (!key || skill.setup || !skill.url || !contents.has(skill.digest!)) continue;
      const result = z.object({ ok: z.literal(true), path: z.string().min(1) })
        .safeParse(await call("openwork_skill_folder", { url: skill.url }).catch(() => null));
      if (result.success) folders.set(key, result.data.path);
      else folders.delete(key);
    }
  };

  const warmEntries = () => {
    const listed = new Set(nativeSkills(catalog, contents).map(skill => skill.id));
    return catalog.skills.filter(skill => warm.includes(skillId(skill)) && listed.has(skillId(skill)));
  };

  let publishing = Promise.resolve();
  const publish = () => {
    publishing = publishing.catch(() => {}).then(async () => {
      const wanted = new Set(warmEntries().flatMap(skill => skill.digest && !skill.setup ? [skill.digest] : []));
      for (const digest of contents.keys()) if (!wanted.has(digest)) contents.delete(digest);
      const wantedFolders = new Set(warmEntries().flatMap(skill => folderKey(skill) ?? []));
      for (const key of folders.keys()) if (!wantedFolders.has(key)) folders.delete(key);
      const next = nativeSkills(catalog, contents, folders);
      const key = JSON.stringify(next);
      if (closed || key === fingerprint) return;
      skills = next;
      if (skills.length === 0) {
        const current = registration;
        registration = undefined;
        await current?.dispose();
      } else if (!registration) {
        const current = await context.skill.transform(editor => {
          for (const skill of skills) editor.add(skill);
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

  const use = async (ids: Iterable<string>) => {
    const registered = new Set(skills.map(skill => skill.id));
    const used = new Set([...ids].filter(id => registered.has(id)));
    const entries = catalog.skills.filter(skill => used.has(skillId(skill)));
    if (entries.length === 0) return;
    try {
      await readBodies(entries, true);
      await ensureFolders(entries);
      for (const skill of entries) {
        const id = skillId(skill);
        warm.splice(0, warm.length, ...warm.filter(entry => entry !== id), id);
      }
      warm.splice(0, Math.max(0, warm.length - MAX_WARM_SKILLS));
      await publish();
    } catch {
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
      await readBodies(warmEntries().filter(skill => skill.digest && !contents.has(skill.digest)), false);
      await ensureHooks();
      await publish();
    } catch {
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
