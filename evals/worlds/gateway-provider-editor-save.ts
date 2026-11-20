import type { Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import { isRecord } from "./library.ts";

export const VERTEX_PILOT_NAME = "Vertex pilot";

/** A cloud Den with a staged Vertex provider and its owner signed in on the editor. */
export async function gatewayProviderEditorSaveWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    // Vertex member sign-in is supported by default when AI Gateway is enabled.
    const gateway = await gatewayEnvironment("https://aiplatform.googleapis.com");
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Gateway editor proof", admin: { name: "Gateway owner" } } }));
    if (!den.database) throw new Error("The Gateway editor world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST",
      body: JSON.stringify({ name: VERTEX_PILOT_NAME, providerId: "google-vertex", modelIds: [], settings: { project: "example-project", location: "global" }, status: "disabled" }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
    if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Staging Vertex failed: ${created.response.status} ${created.text.slice(0, 400)}`);
    const providerPath = `/v1/inference-providers/${provider.id}`;
    const startPath = `/dashboard/ai-gateway/providers/${provider.id}`;
    const web = await seed.web({ den, signedInAs: den.admin, startPath, headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      providerPath,
      editorUrl: new URL(startPath, den.ref.webUrl).href,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
