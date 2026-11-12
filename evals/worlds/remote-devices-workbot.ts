import type { Seed } from "@openwork/env";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { bootWorkbot, enableWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";
import { ACME_MODEL, gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { denFetch } from "../packages/behaviors/src/den.ts";

/**
 * The real signed-in Workbot and Den. Organization management is proved
 * separately in den-computers, with a non-platform organization admin.
 * No cloud computer is created: this fixture has no desktop provider, so opening the Computer
 * view fails honestly, which is exactly what the devices registry should show.
 */
export async function remoteDevicesWorkbotWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    // The real runner must report its per-chat session cell to Den before Den
    // can authorize a device report for it. bootWorkbot allocates Den's port
    // internally, so a loopback-only forwarding address wires that callback
    // without replacing either service or manufacturing a session-index row.
    let denApi: string | undefined;
    const callbacks = createServer(async (request, response) => {
      if (!denApi || !["/v1/internal/headless/index", "/v1/headless/resume-token"].includes(request.url ?? "")) {
        response.writeHead(503).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const forwarded = await fetch(`${denApi}${request.url}`, {
          method: "POST",
          headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
          body: Buffer.concat(chunks), signal: AbortSignal.timeout(10_000),
        });
        response.writeHead(forwarded.status, { "content-type": "application/json" }).end(await forwarded.text());
      } catch { response.writeHead(502).end(); }
    });
    await new Promise<void>(resolve => callbacks.listen(0, "127.0.0.1", resolve));
    stack.defer(() => new Promise<void>((resolve, reject) => callbacks.close(error => error ? reject(error) : resolve())));
    const callbackToken = randomBytes(32).toString("hex");
    const workbot = await bootWorkbot(stack, undefined, {
      live: false,
      upstream: { baseUrl: upstream.baseUrl, key: upstream.key, model: ACME_MODEL },
      denEnv: { ...gateway.env, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callbackToken },
      runnerEnv: {
        HEADLESS_DEN_API_URL: `http://127.0.0.1:${(callbacks.address() as AddressInfo).port}`,
        HEADLESS_DEN_CALLBACK_TOKEN: callbackToken, HEADLESS_GRANT_KEY: randomBytes(32).toString("hex"),
      },
    });
    denApi = workbot.den.ref.apiUrl;
    if (!workbot.den.database) throw new Error("The Workbot fixture needs its disposable local database");
    await startAcmeGateway(stack, workbot.den.database.url, gateway);
    const provider = await seedAcmeGateway(workbot.den.admin, upstream);
    const owner = { authorization: `Bearer ${workbot.den.admin.token}`, "x-openwork-org-id": workbot.orgId };
    const model = await denFetch(workbot.den.admin, "/v1/org/workbot-settings", { method: "PUT", headers: owner, body: JSON.stringify({ model: provider.modelId }) });
    if (!model.response.ok) throw new Error(`Could not choose Workbot's model: HTTP ${model.response.status} ${model.text.slice(0, 200)}`);
    const signed = await signInWorkbot(workbot);
    // A conversation must exist, or Workbot opens on its first-run welcome instead of Home.
    const sent = await signed.call("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: "devices_proof_hello", text: "Hello" }) });
    if (sent.status !== 202) throw new Error(`Workbot refused the seed message: HTTP ${sent.status} ${(await sent.text()).slice(0, 200)}`);
    const viewport = { width: 1280, height: 900 };
    const web = await seed.web({ den: workbot.den, headless: true, viewport });
    for (const pair of signed.cookie.split("; ")) {
      const equal = pair.indexOf("=");
      await web.client.send("Network.setCookie", { name: pair.slice(0, equal), value: pair.slice(equal + 1), url: workbot.workbotUrl, httpOnly: true, sameSite: "Lax" });
    }
    await web.client.send("Page.navigate", { url: `${workbot.workbotUrl}/` });
    const send = async (method: "PUT" | "POST", path: string, body: unknown) => {
      const result = await denFetch(workbot.den.admin, path, { method, headers: owner, body: JSON.stringify(body) });
      if (!result.response.ok) throw new Error(`${method} ${path} failed: HTTP ${result.response.status} ${result.text.slice(0, 200)}`);
    };
    return {
      web,
      call: signed.call,
      /** Workbot's computer and Devices, on or off together for the seeded organization. */
      setEnabled: (value: boolean) => enableWorkbot(workbot.den, { computerUse: value, browserUse: value, remoteComputers: value, remoteDevices: value }),
      /** What the person's signed-in OpenWork Desktop sends on launch, through the route it uses. */
      desktopSignsIn: () => send("PUT", "/v1/remote-devices/this-computer", {
        installId: "devices-proof-macbook", label: "Alex's MacBook Pro", platform: "darwin", appVersion: "1.5.0", osVersion: "25.1.0", arch: "arm64",
        computerUse: {
          enabled: true, remoteEnabled: false, selectedId: "this-mac",
          computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "ready", detail: null }],
          permissions: { accessibility: true, screenRecording: true },
        },
      }),
      /** An admin registers a Mac sandbox for everyone, as Settings › Devices does. */
      shareMacSandbox: () => send("POST", "/v1/remote-devices", { label: "Design review Mac", provider: "mac_host", platform: "darwin", externalId: "local:design-review", shared: true }),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
