import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { managedInference } from "@openwork/env";
import type { Place } from "@openwork/env";
import { openWorkModelConfigurations } from "../../packages/types/src/den/inference.ts";
import { bootManagedOpenworkServer } from "./openwork-server-cli.ts";

export async function bootManagedInference(place: Place) {
  const service = await managedInference(place);
  const resources = new AsyncDisposableStack();
  resources.use(service);
  return {
    ...service,
    async bootEngine() {
      const scratch = await realpath(await mkdtemp(join(tmpdir(), "openwork-managed-inference-")));
      resources.defer(() => rm(scratch, { recursive: true, force: true }));
      const workspace = join(scratch, "workspace");
      await mkdir(workspace);
      const file = join(workspace, "inference-fixture.txt");
      await writeFile(file, "Managed inference tool result\n");
      service.witness.readToolFile(file);
      const identity = service.identities[0];
      if (!identity) throw new Error("Missing fixture identity");
      await writeFile(join(workspace, "opencode.json"), JSON.stringify({
        enabled_providers: ["openwork"],
        model: "openwork/z-ai/glm-5.2", small_model: "openwork/z-ai/glm-5.2",
        provider: { openwork: {
          npm: "@openrouter/ai-sdk-provider", name: "OpenWork Models",
          options: { baseURL: `${service.url}/api/v1`, apiKey: identity.key },
          models: openWorkModelConfigurations(), whitelist: Object.keys(openWorkModelConfigurations()),
        } },
      }));
      let output = "";
      const engine = await bootManagedOpenworkServer({ scratch, workspace, token: "managed-inference-fixture-client", sink: (chunk) => { output += chunk; } });
      resources.defer(() => engine.stop());
      return { ...engine, output: () => output };
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
