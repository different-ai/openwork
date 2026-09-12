import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { appWeb, eventually, needs, SkipError, test } from "@openwork/testkit";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { buildOpenworkProviderContributions } from "../../apps/server/src/opencode-plugins/openwork-provider-adapters";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputOf(output: string): Record<string, unknown> {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value)) throw new Error("Expected an affordance response");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

test("session.create advertises clipping and returns every validation issue without creating sessions", async ({ evidence }) => {
  const create = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances).find((entry) => entry.id === "session.create");
  const description = create?.arguments.find((argument) => argument.name === "sessions")?.description;
  expect(description).toContain("title (≤120 chars, longer is clipped)");
  expect(description).toContain("prompt (≤100000 chars)");
  const plugin = await OpenWorkExtensionsPreview();
  const output = outputOf(await plugin.tool.openwork_execute.execute({ id: "session.create", args: { sessions: [
    { title: "", prompt: "Valid prompt" },
    { title: "First", prompt: "P".repeat(100_001) },
    { title: "Second", prompt: "P".repeat(100_412) },
  ] } }, {}));
  expect(output.ok).toBe(false);
  expect(records(output.issues).map((issue) => issue.path)).toEqual(["sessions[0].title", "sessions[1].prompt", "sessions[2].prompt"]);
  expect(records(output.issues)[2]?.message).toBe("sessions[2].prompt: 100,412 characters, max 100,000");
  expect(output.created).toBeUndefined();
  evidence.recordAssertionEvidence("Clipping is discoverable and validation reports all invalid entries", "The descriptor advertises 120/100000; one response contains the empty title and both oversized prompts, including measured lengths. No server is configured for this validation-only call.", records(output.issues).length === 3 && output.ok === false);
});

// This local headless world runs the real source UI, server, engine, and UI-control
// mailbox. Only model inference is unnecessary: the claim is session creation,
// not a model reply. An explicitly unconfigured model prevents external calls.
test("session.create clips a 145-character title and session.list_sessions returns the persisted label", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  if (place.kind !== "local") throw new SkipError("this headless manifest proof uses the local lane");
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "session-title-cap-")));
  const original = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  try {
    await using app = await appWeb({ name: "session-title-cap", workspacePath: scratch, place });
    const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!runtime || runtime.openworkUrl !== app.openworkUrl || runtime.workspace !== scratch) throw new Error("Could not identify the test-owned headless runtime");
    process.env.OPENWORK_SERVER_URL = runtime.openworkUrl;
    process.env.OPENWORK_SERVER_TOKEN = runtime.token;
    const plugin = await OpenWorkExtensionsPreview({ directory: scratch });
    const title = "T".repeat(145);
    const clipped = `${title.slice(0, 119)}…`;
    const boundary = "B".repeat(120);
    const result = outputOf(await plugin.tool.openwork_execute.execute({
      id: "session.create", args: {
        model: { providerId: "title-test-unconfigured", modelId: "unused" },
        sessions: [{ title, prompt: "Keep this label." }, { title: boundary, prompt: "Keep this other label." }],
      },
    }, {}));
    expect(result.ok).toBe(true);
    const created = isRecord(result.result) ? records(result.result.created) : [];
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ ok: true, title: clipped, titleTruncated: true });
    expect(created[1]).toMatchObject({ ok: true, title: boundary, titleTruncated: false });
    expect(clipped).toHaveLength(120);

    const listed = await eventually(async () => {
      const output = outputOf(await plugin.tool.openwork_query.execute({ id: "session.list_sessions", args: {} }));
      return records(output.result);
    }, { within: 30_000, intervalMs: 250, label: "created labels visible through session.list_sessions", until: (entries) => created.every((session) => entries.some((entry) => entry.sessionId === session.sessionId)) });
    expect(listed.find((entry) => entry.sessionId === created[0]?.sessionId)?.title).toBe(clipped);
    expect(listed.find((entry) => entry.sessionId === created[1]?.sessionId)?.title).toBe(boundary);
    expect(listed.some((entry) => entry.title === title)).toBe(false);
    evidence.recordAssertionEvidence("Real headless affordances persist the clipped label and preserve a boundary label", "session.create accepted both labels: 145 → 120 characters ending in …, titleTruncated=true; 120 unchanged, titleTruncated=false. session.list_sessions returned those exact titles by their created IDs and never returned the original 145-character label.", listed.some((entry) => entry.sessionId === created[0]?.sessionId && entry.title === clipped) && listed.some((entry) => entry.sessionId === created[1]?.sessionId && entry.title === boundary));
  } finally {
    if (original.url === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = original.url;
    if (original.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = original.token;
    await rm(scratch, { recursive: true, force: true });
  }
});
