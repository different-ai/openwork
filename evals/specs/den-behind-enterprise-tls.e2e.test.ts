import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { enterpriseTlsWorld } from "../worlds/first-run.ts";

const PROFILE_MARKER = "enterprise-tls-profile-continuity";
const ASSISTANT_MARKER = "ENTERPRISE-TLS-CHAT-OK";
const CORPORATE_ROOT = "OpenWork Egress Lab Corporate Root CA";

type EdgeRequest = {
  endpoint: string;
  method: string;
  path: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function edgeRequests(value: string): EdgeRequest[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`Enterprise TLS edge returned a non-array request log: ${value}`);
  return parsed.flatMap((entry) => {
    if (!isRecord(entry)
      || typeof entry.endpoint !== "string"
      || typeof entry.method !== "string"
      || typeof entry.path !== "string") return [];
    return [{ endpoint: entry.endpoint, method: entry.method, path: entry.path }];
  });
}

function defaultModelId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.defaultModel) || typeof value.defaultModel.modelID !== "string") return null;
  return value.defaultModel.modelID;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const test = spec.world(enterpriseTlsWorld, {
  needs: { env: ["ANTHROPIC_API_KEY"], placement: "daytona" },
  timeout: 1_200_000,
});

test("Linux OS trust lets OpenWork use one corporate TLS Den without trusting an unrelated private CA", async ({
  world,
  user,
  agent,
  probe,
  seed,
  step,
}) => {
  await step("Before OS trust, cloud sign-in does not falsely succeed", async () => {
    try {
      await agent.run("auth.exchange-grant", { grant: world.grant, baseUrl: world.edge.candidateUrl });
    } catch {
      // The TLS failure may reject the action or return without authenticating.
    }

    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    expect(await probe.storage("openwork.den.activeOrgId")).toBeNull();
    expect(world.app.readiness.workspaceId).toBeNull();
    await user.notSee("Signed in as");
    await user.notSee("Synced");
    await user.notSee("Connected to OpenWork Cloud");
  });

  const trustedApp = await world.installTrust();
  const trustedUser = user.on(trustedApp);
  const trustedProbe = probe.on(trustedApp);

  await step("After OS trust, the same profile signs in and receives a real reply", async () => {
    // TODO(primitive): read the workspaces persisted in a caller-owned desktop profile.
    const recoveredWorkspaceNames = await trustedProbe.eval(
      `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap")
        .then((state) => state.workspaces.map((workspace) => workspace.displayName))`,
      { awaitPromise: true },
    );
    expect(recoveredWorkspaceNames).toContain(PROFILE_MARKER);
    expect(await trustedProbe.storage("openwork.den.authToken")).toBeTruthy();
    expect(await trustedProbe.storage("openwork.den.activeOrgId")).toBeTruthy();

    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY was empty after needs resolution.");
    // TODO(primitive): configure and reload a local workspace provider.
    const configured = await seed.evalIn(trustedApp, `async (workspaceId, apiKey) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return "missing local server credentials";
      const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
      const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId);
      const patch = await fetch(base + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ opencode: { provider: { anthropic: { options: { apiKey } } } } }),
      });
      if (!patch.ok) return "patch:" + patch.status + ":" + (await patch.text()).slice(0, 300);
      const reload = await fetch(base + "/engine/reload", { method: "POST", headers });
      return reload.ok ? "ok" : "reload:" + reload.status + ":" + (await reload.text()).slice(0, 300);
    }`, { args: [trustedApp.workspaceId, anthropicKey], awaitPromise: true, timeoutMs: 90_000 });
    expect(configured).toBe("ok");

    const preferredModel = process.env.OPENWORK_EVAL_MODEL?.trim() || "big-pickle";
    await trustedUser.click({ role: "button", label: "Change model" });
    await trustedUser.click({ role: "button", label: /^Model\s+Big Pickle/ });
    await trustedUser.see({ placeholder: "Search models..." });
    await trustedUser.click({ role: "button", label: "All models" });
    await trustedUser.type({ placeholder: "Search providers and models..." }, preferredModel, { replace: true });
    await trustedUser.click({ role: "button", label: new RegExp(`${escapeRegExp(preferredModel)}$`, "i") });
    expect(await trustedProbe.storage("openwork.preferences", defaultModelId)).toBe(preferredModel);

    const prompt = `Reply with exactly: ${ASSISTANT_MARKER}`;
    await trustedUser.type("composer", prompt);
    await trustedUser.see("composer", { editable: true, text: prompt });
    // TODO(primitive): observe whether a user-visible button is enabled.
    await trustedProbe.eventually(
      () => trustedProbe.eval(`Boolean([...document.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Run task" && !button.disabled))`),
      { within: 30_000, label: "enabled Run task button", until: (enabled) => enabled === true },
    );
    await trustedUser.click("Run task");
    // TODO(primitive): observe assistant-role message text.
    await trustedProbe.eventually(
      () => trustedProbe.eval(`Boolean([...document.querySelectorAll('[data-message-role="assistant"]')]
        .some((message) => (message.innerText ?? "").includes(${JSON.stringify(ASSISTANT_MARKER)})))`),
      { within: 240_000, label: "real enterprise TLS reply", until: (seen) => seen === true },
    );
    await trustedUser.see({ text: ASSISTANT_MARKER }, { timeoutMs: 240_000 });
  });

  await step("The generated CA bundle trusts only the corporate endpoint", async () => {
    const bundle = await world.inspectBundle();
    expect(bundle.stdout).toContain(CORPORATE_ROOT);

    const selectiveProbe = [
      "import * as https from \"node:https\";",
      "const probe = (url) => new Promise((resolve) => {",
      "  const request = https.get(url + \"/api/runtime-config\", (response) => {",
      "    response.resume(); response.on(\"end\", () => resolve({ ok: true, status: response.statusCode }));",
      "  });",
      "  request.on(\"error\", (error) => resolve({ ok: false, code: error.code, message: error.message }));",
      "});",
      "const candidate = await probe(process.argv[1]);",
      "const negative = await probe(process.argv[2]);",
      "console.log(JSON.stringify({ candidate, negative }));",
      "if (!candidate.ok || candidate.status !== 200) process.exit(21);",
      "if (negative.ok || !/CERT|VERIFY|ISSUER|SIGNATURE/i.test(String(negative.code) + \" \" + String(negative.message))) process.exit(22);",
    ].join("\n");
    const selective = await world.probeSelectiveTrust(Buffer.from(selectiveProbe, "utf8").toString("base64"));
    expect(selective.stdout).toContain('"candidate":{"ok":true,"status":200}');
    expect(selective.stdout).toContain('"negative":{"ok":false');
  });

  await step("The edge accepted no negative-endpoint control-plane route", async () => {
    const logged = edgeRequests((await world.readEdgeRequests()).stdout);
    const candidateRequests = logged.filter((request) => request.endpoint === "trusted-candidate");
    const acceptedNegativeRoutes = logged.filter((request) => request.endpoint === "negative" && request.path.startsWith("/api/"));
    expect(candidateRequests.length).toBeGreaterThan(0);
    expect(candidateRequests.some((request) => request.path.startsWith("/api/"))).toBe(true);
    expect(acceptedNegativeRoutes).toEqual([]);
  });
});
