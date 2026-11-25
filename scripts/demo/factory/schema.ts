import { createRequire } from "node:module";

// YAML and Zod are direct dependencies of the server workspace in this repo.
const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const z: typeof import("../../../apps/server/node_modules/zod/index.cjs").z = require("zod").z;
export const parseYaml: typeof import("../../../apps/server/node_modules/yaml/dist/index.js").parse = require("yaml").parse;

type Infer<T extends import("../../../apps/server/node_modules/zod/index.cjs").ZodType> =
  import("../../../apps/server/node_modules/zod/index.cjs").infer<T>;
const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const nameKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const seconds = z.number().int().min(1).max(3600);
const surface = z.enum(["desktop", "admin", "workbot", "slack", "slide"]);
const asUser = z.strictObject({ persona: text, state: z.enum(["signed_in", "signed_out"]) });
const automationState = z.enum(["active", "paused", "archived"]);
const runStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const turn = { turn: id };
const name = { name: text };
const glob = z.string().min(1).refine((s) => !s.startsWith("/") && !s.includes("\\") && !s.split("/").includes(".."), "expected a workspace-relative glob");

export const action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("sign_in"), email: id, secret_ref: id }),
  z.strictObject({ type: z.literal("new_chat") }),
  z.strictObject({ type: z.literal("ask"), ...turn, prompt: id, model: text, same_thread: z.boolean() }),
  z.strictObject({ type: z.literal("open_chat"), title: text }),
  z.strictObject({ type: z.literal("return_to_chat"), ...turn }),
  z.strictObject({ type: z.literal("open_file_link"), match: text }),
  z.strictObject({ type: z.literal("open_sidebar"), item: text }),
  z.strictObject({ type: z.literal("click"), role: text, ...name, match: z.enum(["exact", "contains"]).default("exact"), pick: z.enum(["unique", "first", "last"]).default("unique") }),
  z.strictObject({ type: z.literal("admin_goto"), path: text.refine((s) => /^\/dashboard(?:[/?]|$)/.test(s) && !/[\\#\s]/.test(s), "expected an admin dashboard path") }),
  z.strictObject({ type: z.literal("wait_turn"), ...turn, timeout_seconds: seconds }),
  z.strictObject({ type: z.literal("show"), seconds, turn: id.optional() }),
  z.strictObject({ type: z.literal("confirm_automation"), ...name }),
  z.strictObject({ type: z.literal("manual"), instruction: text }),
]);

export const check = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("turn_succeeded"), ...turn }),
  z.strictObject({ type: z.literal("file_created"), ...turn, glob }),
  z.strictObject({ type: z.literal("pptx_slide_count"), ...turn, glob, count: z.number().int().positive() }),
  z.strictObject({ type: z.literal("xlsx_has_value"), ...turn, glob, value: z.union([text, z.number()]), near: text }),
  z.strictObject({ type: z.literal("automation_exists"), ...name, state: automationState, created_this_beat: z.boolean().default(false) }),
  z.strictObject({ type: z.literal("automation_run_exists"), ...name, status: runStatus, placement: z.enum(["desktop", "cloud"]).optional() }),
  z.strictObject({ type: z.literal("artifact_frame_has"), text, last_resort: z.literal(true), reason: text }),
  z.strictObject({ type: z.literal("text_contains"), text, ...turn, last_resort: z.literal(true), reason: text }),
  z.strictObject({ type: z.literal("admin_setting_equals"), setting: id, value: z.union([text, z.boolean(), z.number()]) }),
  z.strictObject({ type: z.literal("connect_ready") }),
  z.strictObject({ type: z.literal("workflow_exists"), ...name }),
  z.strictObject({ type: z.literal("scim_member_exists"), ...name, team: text }),
  z.strictObject({ type: z.literal("browser_page_loaded"), url: z.url() }),
  z.strictObject({ type: z.literal("slide_visible"), title: text }),
  z.strictObject({ type: z.literal("workbot_reply_received"), channel: text }),
]);
const question = z.union([
  z.strictObject({ question: text, answer: text }),
  z.strictObject({ question: text, beat: id }),
]);
export const beat = z.strictObject({
  id, title: text, surface, label: z.enum(["REAL", "SEEDED", "MOCKED"]),
  status: z.enum(["grounded", "draft"]), requires: z.array(id), provides: z.array(id).default([]),
  do: z.array(action).min(1), say: text, paste: z.record(id, text), see: text,
  checks: z.array(check), reset: z.array(text), fallback: text,
  expect_seconds: seconds, questions: z.array(question), avoid: z.array(text),
});
export const startState = z.strictObject({
  auth: z.array(z.strictObject({ surface, ...asUser.shape })),
  retained: z.strictObject({
    chats: z.array(text), files: z.array(text), artifacts: z.array(text),
    automations: z.array(z.strictObject({ ...name, state: automationState, run: runStatus.optional() })),
  }),
  facts: z.record(id, text),
});
export const desktop = z.strictObject({ id, surfaces: z.array(surface).min(1) });
export const demo = z.strictObject({
  id, title: text, start_state: startState,
  beats: z.array(id).min(1), optional: z.array(id), desktops: z.array(desktop).min(1),
  variables: z.record(nameKey, text),
});
export const personalization = z.strictObject({
  display_name: text.optional(), personas: z.strictObject({ employee: text.optional(), admin: text.optional() }).optional(),
  industry: text.optional(), audience_roles: z.array(text).optional(), avoid: z.array(text).optional(), variables: z.record(nameKey, text).optional(),
});
export const ready = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("auth"), surface, ...asUser.shape }),
  z.strictObject({ type: z.literal("retained_chat"), title: text }),
  z.strictObject({ type: z.literal("retained_file"), path: text }),
  z.strictObject({ type: z.literal("retained_artifact"), title: text }),
  z.strictObject({ type: z.literal("retained_automation"), ...name, state: automationState, run: runStatus.optional() }),
  z.strictObject({ type: z.literal("start_fact"), id, expectation: text }),
]);
export const plan = z.strictObject({
  version: z.literal(1), demo: id, mode: z.literal("declarative-only"), live_proof: z.literal("pending"),
  desktops: z.array(desktop), ready: z.array(ready),
  audience_roles: z.array(text), avoid: z.array(text),
  steps: z.array(z.strictObject({
    id, title: text, surface, desktop: id, status: beat.shape.status, label: beat.shape.label,
    optional: z.boolean(), requires: z.array(id), provides: z.array(id),
    actions: z.array(action), say: text, see: text, checks: z.array(check),
    expect_seconds: seconds, fallback: text, avoid: z.array(text), questions: z.array(question),
  })),
  reset: z.array(z.strictObject({ beat: id, instructions: z.array(text) })),
  prompts: z.record(id, text),
});

export type Action = Infer<typeof action>;
export type Check = Infer<typeof check>;
export type Beat = Infer<typeof beat>;
export type Demo = Infer<typeof demo>;
export type Personalization = Infer<typeof personalization>;
export type Ready = Infer<typeof ready>;
export type Plan = Infer<typeof plan>;
