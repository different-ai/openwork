import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvService } from "../../server/src/env-file";
import type { ServerConfig } from "../../server/src/types";
import { OpenWorkExtensionsPreview } from "../../server/src/opencode-plugins/openwork-extensions-preview";
import { openworkReadTransport } from "../../server/src/opencode-plugins/openwork-read-transport";
import { callOpenAiImageGenerationExtensionAction } from "../../server/src/extensions/openai-image-generation";
import { resolveWorkspaceArtifactTargets } from "../../server/src/routes/files";
import { deriveOpenTargets } from "../src/react-app/domains/session/artifacts/open-target";

const input = { id: "extension.call", args: { extensionId: "openai-image-generation", action: "image_generate", args: { prompt: "A plain blue square", filename: "square" } } };
function targets(output: unknown, request: unknown = input) {
  return deriveOpenTargets([{ id: "image-turn", role: "assistant", parts: [
    { type: "dynamic-tool", toolName: "openwork_execute", toolCallId: "image-call", state: "output-available", input: request, output },
    { type: "text", text: "Voilà." },
  ] }]);
}

test("the registered image executor's real nested receipt discovers the actual PNG without assistant prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-route-evidence-"));
  const env = new EnvService({ path: join(root, "env.json") });
  await env.upsertMany([{ key: "OPENAI_API_KEY", value: "synthetic-image-key" }]);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [],
    workspaces: [{ id: "image-workspace", name: "Images", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root],
    readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const plugin = await OpenWorkExtensionsPreview({ directory: root, workspaceID: "image-workspace" });
  // Only provider egress is mocked. Both the registered executor/affordance
  // envelope and the server extension's file write run their shipping code.
  const provider = spyOn(globalThis, "fetch").mockImplementation(async url => {
    expect(String(url)).toBe("https://api.openai.com/v1/images/generations");
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=" }] });
  });
  try {
    const output = await openworkReadTransport.run({
      get: async () => { throw new Error("The image action must not use a read route"); },
      post: async (path, body) => {
        expect(path).toBe("/experimental/extensions/call");
        expect(body.extensionId).toBe("openai-image-generation");
        expect(body.action).toBe("image_generate");
        return callOpenAiImageGenerationExtensionAction(config, env, "image_generate", input.args.args, { directory: root });
      },
    }, () => plugin.tool.openwork_execute.execute(input, { directory: root, workspaceID: "image-workspace" }));
    const png = await readFile(join(root, "artifacts/square.png"));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(provider).toHaveBeenCalledTimes(1);
    const found = targets(output);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value: "artifacts/square.png", preview: "image", reason: "server-produced file", sourceMessageId: "image-turn" });
    expect((await resolveWorkspaceArtifactTargets(root, found))[0]).toMatchObject({ exists: true, value: "artifacts/square.png" });
    const result = JSON.parse(output);
    expect(targets(result, { ...input, id: "session.send" })).toEqual([]);
    expect(targets({ ...result, id: "session.send" })).toEqual([]);
    expect(targets({ ...result, ok: false })).toEqual([]);
    expect(targets({ ...result, result: { ...result.result, action: "status" } })).toEqual([]);
    expect(targets({ ...result, result: { ...result.result, ok: false } })).toEqual([]);
  } finally {
    provider.mockRestore();
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
