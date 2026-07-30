export interface Actor {
  name: string;
  email: string;
  password: string;
  role: "owner" | "member" | "fresh";
}

export type ActorSpec = Actor | "owner" | "fresh" | {
  persona: "owner" | "fresh";
  prefix?: string;
};

const FRESH_PASSWORD = "OpenWorkEval123!";
const PROCESS_RUNSTAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Actor["role"] {
  return value === "owner" || value === "member" || value === "fresh";
}

function isActor(value: unknown): value is Actor {
  return isRecord(value) && typeof value.name === "string" && typeof value.email === "string" && typeof value.password === "string" && isRole(value.role);
}

function runStamp(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENWORK_EVAL_RUNSTAMP?.trim() || env.OPENWORK_EVAL_RUN_STAMP?.trim();
  if (configured) return configured.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "run";
  return PROCESS_RUNSTAMP;
}

function emailPrefix(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "fresh";
}

function withName(actor: Actor, name: string): Actor {
  if (actor.name === name) return actor;
  return { ...actor, name };
}

export const persona = {
  owner(env: NodeJS.ProcessEnv): Actor {
    return {
      name: "owner",
      email: env.DEN_DEMO_OWNER_EMAIL ?? "alex@acme.test",
      password: env.DEN_DEMO_OWNER_PASSWORD ?? "OpenWorkDemo123!",
      role: "owner",
    };
  },
  fresh(prefix: string, env: NodeJS.ProcessEnv): Actor {
    return {
      name: prefix,
      email: `${emailPrefix(prefix)}-${runStamp(env)}@eval.openwork.test`,
      password: FRESH_PASSWORD,
      role: "fresh",
    };
  },
};

function resolveActor(name: string, spec: ActorSpec, env: NodeJS.ProcessEnv): Actor {
  if (isActor(spec)) return withName(spec, name);
  if (spec === "owner") return withName(persona.owner(env), name);
  if (spec === "fresh") return withName(persona.fresh(name, env), name);
  if (spec.persona === "owner") return withName(persona.owner(env), name);
  return withName(persona.fresh(spec.prefix ?? name, env), name);
}

export function resolveActors(spec: Record<string, ActorSpec>, env: NodeJS.ProcessEnv): Record<string, Actor> {
  const actors: Record<string, Actor> = {};
  for (const [name, actorSpec] of Object.entries(spec)) {
    actors[name] = resolveActor(name, actorSpec, env);
  }
  return actors;
}
