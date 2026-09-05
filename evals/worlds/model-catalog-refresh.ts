import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Seed } from "@openwork/env";
import { close, listen, sendJson } from "./openwork-server-cli.ts";

const run = promisify(execFile);
const updater = resolve(import.meta.dirname, "../../ee/apps/inference/scripts/update-models.mjs");

// Exercise the same updater CLI that the scheduled workflow runs. Only the
// upstream HTTP catalog is a fixture; snapshot validation/replacement is real.
export async function modelCatalogRefresh(seed: Seed) {
  const root = seed.tmpPath("model-catalog-refresh");
  await mkdir(root, { recursive: true });
  const destination = join(root, "base.json");
  let payload: unknown = {};
  let status = 200;
  let requests = 0;
  const upstream = createServer((request, response) => {
    if (request.url !== "/api.json") return sendJson(response, 404, {});
    requests++;
    sendJson(response, status, payload);
  });
  const url = await listen(upstream);
  return {
    async refresh(next: unknown, responseStatus = 200) {
      payload = next;
      status = responseStatus;
      try {
        await run(process.execPath, [updater], {
          cwd: root,
          env: { ...process.env, MODELS_URL: `${url}/api.json`, MODELS_PATH: destination, GITHUB_OUTPUT: join(root, "outputs") },
          timeout: 40_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    automaticApproval: async () => (await readFile(join(root, "outputs"), "utf8")).trim().split("\n").at(-1) === "safe_to_approve=true",
    snapshot: () => readFile(destination, "utf8"),
    requests: () => requests,
    async [Symbol.asyncDispose]() { await close(upstream); },
  };
}
