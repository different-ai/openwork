import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eventually, test } from "@openwork/testkit";
import { expect } from "vitest";
import versions from "../../constants.json";
import { ownedProvider } from "../../apps/server/src/free-auto/provider-config";
import { createManagedOpencodeServer } from "../../apps/server/src/managed-opencode";
import { createManagedOpencodeV2Server, installOpencodeV2Binary } from "../../apps/server/src/managed-opencode-v2";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../../apps/server/src/openwork-runtime-config";

const exec = promisify(execFile);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const AUTO = "openai/gpt-6-luna";
// The entry earlier builds wrote, kept beside the current one as the "before".
const TEXT_ONLY = "openai/gpt-6-luna-text-only";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

for (const engine of ["v1", "v2"]) {
  test(`${engine} offers images to free Auto and still withholds them from the earlier text-only entry`, { timeout: 180_000 }, async ({ evidence }) => {
    const binary = engine === "v1"
      ? process.env.OPENWORK_EVAL_OPENCODE_BIN_V1 ?? join(import.meta.dirname, "../../apps/desktop/resources/sidecars", process.platform === "win32" ? "opencode.exe" : "opencode")
      : process.env.OPENWORK_EVAL_OPENCODE2_BIN ?? await installOpencodeV2Binary(join(tmpdir(), "openwork-opencode-v2-verified"), versions.opencodeV2Version);
    expect((await exec(binary, ["--version"])).stdout.trim()).toBe(
      engine === "v1" ? versions.opencodeVersion.replace(/^v/, "") : `opencode2 v${versions.opencodeV2Version}`,
    );

    // Records what each model request carries; never runs a real model.
    const requests: { model: unknown; image: boolean }[] = [];
    const witness = createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body: unknown = JSON.parse(text);
      if (isRecord(body)) requests.push({ model: body.model, image: text.includes(PNG) });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic wire witness", type: "invalid_request_error" } }));
    });
    await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
    const address = witness.address();
    if (!address || typeof address === "string") throw new Error("Witness did not bind");

    // Exactly what the server registers for Auto, pointed at the witness instead of the relay.
    const provider = ownedProvider(`owf_local_${"a".repeat(43)}`, address.port);
    const current = provider.models[AUTO];
    const textOnly = { ...current, id: TEXT_ONLY, attachment: false, modalities: { input: ["text"], output: ["text"] } };
    const models = { [AUTO]: current, [TEXT_ONLY]: textOnly };
    const root = await mkdtemp(join(tmpdir(), "free-auto-images-"));
    const directory = join(root, "workspace");
    await mkdir(directory);
    const configPath = join(root, "base.json");
    const runtime = buildOpenworkRuntimeConfigObjectFromSnapshot({ provider: { "openwork-free": { ...provider, models } } });
    await writeFile(configPath, JSON.stringify(engine === "v1" ? { provider: runtime.provider } : {}));
    const env = {
      HOME: root, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_MODELS_FETCH: "1",
      XDG_CONFIG_HOME: join(root, "xdg"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    };
    const server = engine === "v1"
      ? await createManagedOpencodeServer({ bin: binary, cwd: directory, env, timeoutMs: 60_000 })
      : await createManagedOpencodeV2Server({ bin: binary, rootDir: root, env });
    try {
      if ("injectProvider" in server) {
        await server.injectProvider({
          id: "openwork-free", name: provider.name, apiKey: provider.options.apiKey, baseUrl: provider.options.baseURL,
          package: "@opencode-ai/ai/providers/openai",
          models: Object.entries(models).map(([id, config]) => ({ id, name: config.name, config })),
        });
      }
      const request = async (path: string, body?: unknown): Promise<unknown> => {
        const url = new URL(path, server.url);
        url.searchParams.set(engine === "v1" ? "directory" : "location[directory]", directory);
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json", authorization:
            `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}` },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const catalog = await eventually(
        async () => JSON.stringify(await request(engine === "v1" ? "/provider" : "/api/model")),
        { within: 15_000, intervalMs: 100, label: "the Auto provider becomes visible", until: (value) => value.includes(TEXT_ONLY) },
      );

      if (engine === "v2") {
        // v2 prompts are text; images reach the model from tools, which the engine offers only to image-input models.
        const payload: unknown = JSON.parse(catalog);
        const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
        const input = (id: string) => {
          const entry = entries.find((item) => isRecord(item) && item.id === id);
          const capabilities = isRecord(entry) && isRecord(entry.capabilities) ? entry.capabilities : {};
          return Array.isArray(capabilities.input) ? capabilities.input : [];
        };
        evidence.recordAssertionEvidence("v2 lists Auto as reading images; the earlier entry stays text-only",
          JSON.stringify({ auto: input(AUTO), earlier: input(TEXT_ONLY) }), input(AUTO).includes("image") && !input(TEXT_ONLY).includes("image"));
        expect(input(AUTO)).toContain("image");
        expect(input(TEXT_ONLY)).not.toContain("image");
        return;
      }

      // v1 sends an attached image with the prompt when the model reads images.
      const sent: Record<string, boolean> = {};
      for (const model of [AUTO, TEXT_ONLY]) {
        const created = await request("/session", { title: "Image dispatch witness" });
        if (!isRecord(created) || typeof created.id !== "string") throw new Error("Session ID missing");
        const offset = requests.length;
        await request(`/session/${created.id}/message`, { model: { providerID: "openwork-free", modelID: model }, parts: [
          { type: "text", text: "What is in this image?" },
          { type: "file", mime: "image/png", filename: "dot.png", url: `data:image/png;base64,${PNG}` },
        ] });
        const dispatched = await eventually(
          () => requests.slice(offset).find((entry) => entry.model === model),
          { within: 30_000, intervalMs: 100, label: `${model} reaches the wire`, until: (value) => value !== undefined },
        );
        sent[model] = dispatched?.image === true;
      }
      evidence.recordAssertionEvidence("v1 sends the attached image to Auto, not to the earlier text-only entry",
        JSON.stringify(sent), sent[AUTO] === true && sent[TEXT_ONLY] === false);
      expect(sent[AUTO]).toBe(true);
      expect(sent[TEXT_ONLY]).toBe(false);
    } finally {
      await server.close();
      witness.closeAllConnections();
      await new Promise<void>((resolve, reject) => witness.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
