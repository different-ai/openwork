import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beat, demo, parseYaml, personalization, plan } from "./schema.ts";
import type { Beat, Demo, Plan, Ready } from "./schema.ts";

export function readYaml(path: string): unknown {
  try {
    return parseYaml(readFileSync(path, "utf8"), { maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`Cannot read YAML ${path}`, { cause: error });
  }
}

export function load(demoPath: string, personalizationPath?: string, beatDir = join(import.meta.dirname, "beats")) {
  const library = readdirSync(beatDir).sort().filter((f) => /\.ya?ml$/.test(f)).map((file) => {
    const item = beat.parse(readYaml(join(beatDir, file)));
    if (item.id !== file.replace(/\.ya?ml$/, "")) throw new Error(`${file}: id must match filename`);
    return item;
  });
  return compile(readYaml(demoPath), library, personalizationPath ? readYaml(personalizationPath) : {});
}

function interpolate(value: unknown, variables: Record<string, string>, where: string): unknown {
  if (typeof value === "string") {
    const result = value.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, key: string) => {
      const replacement = variables[key];
      if (!Object.hasOwn(variables, key) || replacement === undefined) throw new Error(`${where}: unknown variable ${key}`);
      return replacement;
    });
    if (/\{\{|\}\}/.test(result)) throw new Error(`${where}: malformed or nested variable`);
    return result;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, variables, where));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, variables, `${where}.${k}`)]));
  }
  return value;
}

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

export function compile(rawInput: unknown, libraryInput: unknown[], personalInput: unknown = {}) {
  const raw = demo.parse(rawInput);
  const personal = personalization.parse(personalInput);
  const library = libraryInput.map((b) => beat.parse(b));
  unique(library.map((b) => b.id), "beat ID");
  const byId = new Map(library.map((b) => [b.id, b]));
  for (const b of library) {
    unique(b.requires, `${b.id} prerequisite`);
    unique(b.provides, `${b.id} provided fact`);
    for (const q of b.questions) {
      if ("beat" in q && !byId.has(q.beat)) throw new Error(`${b.id}: unknown Q&A beat ${q.beat}`);
    }
  }
  for (const key of Object.keys(personal.variables ?? {})) {
    if (!Object.hasOwn(raw.variables, key)) throw new Error(`Unknown personalization override ${key}`);
  }
  const variables = {
    ...raw.variables,
    ...(personal.display_name === undefined ? {} : { display_name: personal.display_name }),
    ...(personal.personas?.employee === undefined ? {} : { employee: personal.personas.employee }),
    ...(personal.personas?.admin === undefined ? {} : { admin: personal.personas.admin }),
    ...(personal.industry === undefined ? {} : { industry: personal.industry }),
    ...personal.variables,
  };
  const rendered = demo.parse(interpolate(raw, variables, raw.id));
  const allIds = [...rendered.beats, ...rendered.optional];
  unique(allIds, "demo beat reference");
  unique(rendered.desktops.map((d) => d.id), "desktop ID");
  unique(rendered.desktops.flatMap((d) => d.surfaces), "desktop surface assignment");
  unique(rendered.start_state.auth.map((a) => a.surface), "start-state auth surface");
  const desktopFor = new Map(rendered.desktops.flatMap((d) => d.surfaces.map((s): [typeof s, string] => [s, d.id])));
  for (const a of rendered.start_state.auth) if (!desktopFor.has(a.surface)) throw new Error(`No desktop for auth surface ${a.surface}`);
  const beats = allIds.map((id) => {
    const b = byId.get(id);
    if (!b) throw new Error(`Unknown beat ${id}`);
    if (!desktopFor.has(b.surface)) throw new Error(`${id}: no desktop for ${b.surface}`);
    return beat.parse(interpolate(b, variables, id));
  });

  const main = beats.slice(0, rendered.beats.length);
  const optional = beats.slice(main.length);
  for (const b of main) if (b.status === "draft") throw new Error(`${b.id}: draft beats must be optional pending live proof`);
  validateOrder(main, rendered);
  // Every optional branch must work after main, without relying on another optional beat.
  for (const b of optional) validateOrder([...main, b], rendered);
  const prompts = validateOrder(beats, rendered);
  return { demo: rendered, main, optional, personal, desktopFor, prompts };
}

function validateOrder(beats: Beat[], demo: Demo) {
  const facts = new Set(Object.keys(demo.start_state.facts));
  const turns = new Map<string, { surface: Beat["surface"]; waited: boolean; shown: boolean }>();
  const current = new Map<Beat["surface"], string>();
  const prompts = new Map<string, string>();
  for (const b of beats) {
    for (const fact of b.requires) if (!facts.has(fact)) throw new Error(`${b.id}: missing prerequisite ${fact}`);
    for (const [key, value] of Object.entries(b.paste)) {
      if (prompts.has(key)) throw new Error(`${b.id}: duplicate paste name ${key}`);
      prompts.set(key, value);
    }
    function referencedTurn(id: string) {
      const turn = turns.get(id);
      if (!turn || turn.surface !== b.surface) throw new Error(`${b.id}: unknown prior turn ${id} on ${b.surface}`);
      return turn;
    }
    for (const a of b.do) {
      if (a.type === "ask" || a.type === "sign_in") {
        const key = a.type === "ask" ? a.prompt : a.email;
        if (!Object.hasOwn(b.paste, key)) throw new Error(`${b.id}: missing paste value ${key}`);
      }
      if (a.type === "new_chat" || a.type === "open_chat" || a.type === "sign_in") current.delete(b.surface);
      if (a.type === "ask") {
        if (turns.has(a.turn)) throw new Error(`${b.id}: duplicate turn ${a.turn}`);
        if (a.same_thread && !current.has(b.surface)) throw new Error(`${b.id}: same_thread requires a prior chat on ${b.surface}`);
        turns.set(a.turn, { surface: b.surface, waited: false, shown: false });
        current.set(b.surface, a.turn);
      } else if ("turn" in a && a.turn) {
        const turn = referencedTurn(a.turn);
        if (a.type === "return_to_chat") current.set(b.surface, a.turn);
        if (a.type === "wait_turn") turn.waited = true;
        if (a.type === "show") {
          if (!turn.waited) throw new Error(`${b.id}: wait for ${a.turn} before showing it`);
          if (current.get(b.surface) !== a.turn) throw new Error(`${b.id}: return to ${a.turn} before showing it`);
          turn.shown = true;
        }
      }
    }
    for (const c of b.checks) if ("turn" in c && !referencedTurn(c.turn).waited) {
      throw new Error(`${b.id}: wait for ${c.turn} before checking it`);
    }
    for (const fact of b.provides) {
      if (facts.has(fact)) throw new Error(`${b.id}: fact ${fact} already provided`);
      facts.add(fact);
    }
  }
  for (const [id, turn] of turns) if (!turn.shown) throw new Error(`Started turn ${id} has no show step`);
  for (const b of beats) for (const a of b.do) if (a.type === "sign_in" && prompts.has(a.secret_ref)) {
    throw new Error(`${b.id}: secret ref ${a.secret_ref} cannot be a paste value`);
  }
  return Object.fromEntries(prompts);
}

export type Composition = ReturnType<typeof compile>;
export const selectedBeats = (c: Composition, optional: boolean) => optional ? [...c.main, ...c.optional] : c.main;
export function makePlan(c: Composition, optional = false): Plan {
  const { auth, retained, facts } = c.demo.start_state;
  const beats = selectedBeats(c, optional);
  const requiredFacts = new Set(beats.flatMap((b) => b.requires));
  const ready: Ready[] = [
    ...auth.map((a): Ready => ({ type: "auth", ...a })),
    ...retained.chats.map((title): Ready => ({ type: "retained_chat", title })),
    ...retained.files.map((path): Ready => ({ type: "retained_file", path })),
    ...retained.artifacts.map((title): Ready => ({ type: "retained_artifact", title })),
    ...retained.automations.map((a): Ready => ({ type: "retained_automation", ...a })),
    ...Object.entries(facts).filter(([id]) => requiredFacts.has(id)).map(([id, expectation]): Ready => ({ type: "start_fact", id, expectation })),
  ];
  return plan.parse({
    version: 1, demo: c.demo.id, mode: "declarative-only", live_proof: "pending", desktops: c.demo.desktops, ready,
    audience_roles: c.personal.audience_roles ?? [], avoid: c.personal.avoid ?? [],
    steps: beats.map((b) => ({
      id: b.id, title: b.title, surface: b.surface, desktop: c.desktopFor.get(b.surface), status: b.status,
      label: b.label, optional: !c.demo.beats.includes(b.id), requires: b.requires, provides: b.provides,
      actions: b.do, checks: b.checks, say: b.say, see: b.see, expect_seconds: b.expect_seconds,
      fallback: b.fallback, avoid: b.avoid, questions: b.questions,
    })),
    reset: beats.toReversed().filter((b) => b.reset.length).map((b) => ({ beat: b.id, instructions: b.reset })),
    prompts: Object.fromEntries(beats.flatMap((b) => Object.entries(b.paste))),
  });
}
