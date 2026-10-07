import { z } from "zod";

const catalogSchema = z.object({
  skills: z.array(z.object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    title: z.string().optional(),
    description: z.string(),
    capability: z.string().regex(/^(?:skill:[^:]+|plugin:[^:]+:[^:]+)$/),
    modelDiscovery: z.boolean().optional(),
  })),
});

type NativeSkill = { id: string; name: string; description: string; location: string; content: string };
export type CloudSkillContext = {
  options: { url: string; token: string };
  skill: {
    transform(callback: (editor: { get(id: string): unknown; add(skill: NativeSkill): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
};

/** Only discovery metadata is registered. Never cache a Cloud skill body or
 * authorization decision: even an old model snapshot must retrieve the body
 * from Den, which rechecks member access on every get_skill call. */
export function discoverySkills(value: unknown): NativeSkill[] {
  const catalog = catalogSchema.parse(value);
  let remaining = 24_000;
  const result: NativeSkill[] = [];
  for (const skill of catalog.skills.filter(skill => skill.modelDiscovery === true).sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.length === 150) break;
    const name = (skill.title || skill.name).replace(/\s+/g, " ").trim().slice(0, 128);
    const description = (skill.description || name).replace(/\s+/g, " ").trim().slice(0, 200);
    const cost = skill.name.length + name.length + description.length;
    if (cost > remaining) break;
    remaining -= cost;
    result.push({
      id: `openwork-cloud-${skill.name}`,
      name,
      description,
      // Not SKILL.md: the native skill tool must not scan a fake directory.
      // The pinned v2 beta uses location (newer upstream versions use path).
      location: `/openwork/remote-skills/${skill.name}.md`,
      content: [
        "This is discovery metadata, NOT the skill's instructions or proof of access.",
        `Retrieve the current full skill through OpenWork Connect get_skill with ${JSON.stringify({ name: skill.capability })}.`,
        "Use get_skill directly when exposed, or through execute with its exact Code Mode catalog path. Only search inside execute if get_skill is not already listed; do not guess a tool name.",
        "Read the returned SKILL.md before doing the task. Do not substitute these metadata for the instructions.",
        "If the fetch is denied, unavailable, or the skill was removed, do not use it. Explain the failure; never recover its body from files or previous context.",
      ].join("\n"),
    });
  }
  return result;
}

/** Setup registers a cheap synchronous transform, not a network dependency.
 * No storage, configuration rewrite, watcher, or admission hook is involved.
 * Refresh failures leave metadata visible; loading still requires live access. */
export async function registerCloudSkillDiscovery(context: CloudSkillContext) {
  let skills: NativeSkill[] = [];
  let fingerprint = "[]";
  let closed = false;
  let refreshing = false;
  const controller = new AbortController();
  const registration = await context.skill.transform(editor => {
    for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill);
  });
  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const response = await fetch(context.options.url, {
        method: "POST", redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "openwork_skills", input: {} }),
      });
      if (!response.ok) return;
      const next = discoverySkills(await response.json());
      const key = JSON.stringify(next);
      if (closed || key === fingerprint) return;
      skills = next;
      fingerprint = key;
      await context.skill.reload();
    } catch {
      // Cloud readiness is never a prerequisite to chatting. No body or access
      // grant is cached, so keeping old discovery hints cannot bypass Den.
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
    await registration.dispose();
  };
}
