import { expect } from "vitest";
import {
  control,
  enabledButtons,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  visibleText,
  waitFor,
} from "@openwork/behaviors";
import {
  checkedExec,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  enterpriseTlsEdgeDaytonaCommands,
  provisionDesktopSandbox,
} from "@openwork/hosts";
import {
  app,
  createDesktopHandoffGrant,
  eventually,
  needs,
  readDenClientState,
  server,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  daytona: true,
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Den behind enterprise TLS skipped — needs: ${missingRequirements.join(", ")}`
  : "Linux OS trust lets OpenWork use one corporate TLS Den without trusting an unrelated private CA";

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function remote(sandbox: string, command: string): string[] {
  return ["exec", sandbox, "--", `bash -lc ${shellQuote(command)}`];
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanup(label: string, action: () => PromiseLike<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`[openwork/testkit] ${label} cleanup failed: ${messageText(error)}`);
  }
}

const assistantHasMarker = `(() => [...document.querySelectorAll('[data-message-role="assistant"]')]
  .some((message) => (message.innerText ?? "").includes(${JSON.stringify(ASSISTANT_MARKER)})))()`;

test.skipIf(missingRequirements.length > 0)(title, { timeout: 1_200_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({ place });
  const provisioned = await provisionDesktopSandbox({
    ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
    name: "den-behind-enterprise-tls",
    reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
    log: (line) => console.error(`[openwork/testkit] ${line}`),
  });
  const profileDir = `/workspace/.openwork-daytona/profiles/enterprise-tls-${process.pid}-${Date.now()}`;
  const edge = enterpriseTlsEdgeDaytonaCommands({
    sandboxId: provisioned.sandbox,
    upstream: den.ref.webUrl,
  });
  let edgeStarted = false;
  let rootInstallAttempted = false;
  let host: ReturnType<typeof daytonaSandbox> | null = null;

  try {
    for (const [index, command] of edge.prepare.entries()) {
      await checkedExec(
        defaultDaytonaExec,
        command,
        `prepare enterprise TLS edge chunk ${index + 1}/${edge.prepare.length}`,
        { timeoutMs: 30_000 },
      );
    }
    await checkedExec(defaultDaytonaExec, edge.start, "start enterprise TLS edge", { timeoutMs: 120_000 });
    edgeStarted = true;
    await checkedExec(defaultDaytonaExec, edge.probe, "probe enterprise TLS edge", { timeoutMs: 30_000 });
    host = daytonaSandbox(provisioned.sandbox);
    const desktopHost = host;

    {
      await using rawApp = await desktop({
        name: "enterprise-tls-before-os-trust",
        host: desktopHost,
        profileDir,
        bootstrap: { baseUrl: edge.candidateUrl, apiBaseUrl: `${edge.candidateUrl}/api/den`, requireSignin: false },
      });
      const seededWorkspaceNames = await evalIn(
        rawApp,
        `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
          folderPath: ${JSON.stringify(`${profileDir}/continuity-workspace`)},
          name: ${JSON.stringify(PROFILE_MARKER)}
        }).then((state) => state.workspaces.map((workspace) => workspace.displayName))`,
        { awaitPromise: true },
      );
      expect(seededWorkspaceNames).toContain(PROFILE_MARKER);
      await waitFor(
        rawApp,
        "Boolean(window.__openworkControl?.listActions?.().some((action) => action.id === 'auth.exchange-grant'))",
        { timeoutMs: 60_000, label: "pre-trust sign-in reachability action" },
      );

      const grant = await createDesktopHandoffGrant(den.admin);
      let exchangeError = "";
      try {
        await control(rawApp, "auth.exchange-grant", { grant, baseUrl: edge.candidateUrl }, { timeoutMs: 60_000 });
      } catch (error) {
        exchangeError = messageText(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const beforeTrustState = await readDenClientState(rawApp);
      const beforeTrustText = await visibleText(rawApp);
      expect(beforeTrustState.authTokenPresent).toBe(false);
      expect(beforeTrustState.activeOrgId).toBeNull();
      expect(rawApp.readiness.workspaceId).toBeNull();
      for (const falseSuccess of ["Signed in as", "Synced", "Connected to OpenWork Cloud"]) {
        expect(beforeTrustText.includes(falseSuccess), `pre-trust UI falsely showed ${JSON.stringify(falseSuccess)}`).toBe(false);
      }

      evidence.recordAssertionEvidence(
        "Before OS trust, a local-first work surface does not falsely claim cloud sign-in, organization, Connected, or Synced success",
        `Grant exchange result was ${JSON.stringify(exchangeError || "action returned without authentication")}. The local composer/work surface is allowed; authTokenPresent=false, activeOrgId=null, workspaceId=null. Visible diagnostics were ${JSON.stringify(beforeTrustText.slice(0, 1_000))}. Enabled controls were ${JSON.stringify(await enabledButtons(rawApp))}.`,
        true,
      );
    }

    rootInstallAttempted = true;
    await checkedExec(
      defaultDaytonaExec,
      edge.installRoot,
      "ENTERPRISE_TLS_ROOT_INSTALL_REQUIRED (root and update-ca-certificates)",
      { timeoutMs: 120_000 },
    );

    const candidateDen = {
      ...den,
      ref: { webUrl: edge.candidateUrl, apiUrl: `${edge.candidateUrl}/api/den` },
    };
    {
      await using trustedApp = await app({
        den: candidateDen,
        as: "admin",
        place,
        host: desktopHost,
        profileDir,
      });
      const recoveredWorkspaceNames = await evalIn(
        trustedApp,
        `window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceBootstrap")
          .then((state) => state.workspaces.map((workspace) => workspace.displayName))`,
        { awaitPromise: true },
      );
      expect(recoveredWorkspaceNames).toContain(PROFILE_MARKER);

      const denState = await readDenClientState(trustedApp);
      expect(denState.authTokenPresent).toBe(true);
      expect(denState.activeOrgId).toBeTruthy();

      const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || "";
      const configured = await evalIn(trustedApp, `(async () => {
        const port = localStorage.getItem("openwork.server.port");
        const token = localStorage.getItem("openwork.server.token");
        if (!port || !token) return "missing local server credentials";
        const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
        const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(trustedApp.workspaceId)});
        const patch = await fetch(base + "/config", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ opencode: { provider: { anthropic: { options: { apiKey: ${JSON.stringify(anthropicKey)} } } } } }),
        });
        if (!patch.ok) return "patch:" + patch.status + ":" + (await patch.text()).slice(0, 300);
        const reload = await fetch(base + "/engine/reload", { method: "POST", headers });
        return reload.ok ? "ok" : "reload:" + reload.status + ":" + (await reload.text()).slice(0, 300);
      })()`, { awaitPromise: true, timeoutMs: 90_000 });
      expect(configured).toBe("ok");

      const preferredModel = process.env.OPENWORK_EVAL_MODEL?.trim() || "";
      const models = await eventually(() => readAvailableModels(trustedApp), {
        within: 60_000,
        label: "Anthropic model catalog after engine reload",
        until: (candidates) => candidates.some(
          (model) => model.selectable && (/anthropic/i.test(model.providerName) || /^claude-/i.test(model.id)),
        ),
      });
      const selectable = models.filter((model) => model.selectable);
      const anthropicModels = selectable.filter((model) => /anthropic/i.test(model.providerName) || /^claude-/i.test(model.id));
      const chosen = selectable.find((model) => model.id === preferredModel)
        ?? anthropicModels.find((model) => /^claude-sonnet-\d+-\d+$/.test(model.id))
        ?? anthropicModels.find((model) => /sonnet/i.test(model.id))
        ?? anthropicModels[0];
      if (!chosen) throw new Error(`No Anthropic model selectable in the picker. Saw: ${models.map((model) => model.id).join(", ") || "none"}`);
      await selectModel(trustedApp, chosen.id);

      await control(trustedApp, "session.create_task");
      await sendComposerMessage(trustedApp, `Reply with exactly: ${ASSISTANT_MARKER}`);
      await waitFor(trustedApp, assistantHasMarker, { timeoutMs: 240_000, label: "real Anthropic enterprise TLS reply" });
      expect((await visibleText(trustedApp)).includes(ASSISTANT_MARKER)).toBe(true);
      evidence.recordAssertionEvidence(
        "After Linux OS trust and an app restart, the same profile signs in, selects its organization, and receives a real Anthropic reply",
        `Profile marker persisted; activeOrgId=${denState.activeOrgId}, activeOrgName=${denState.activeOrgName}, model=${chosen.id}, assistant marker=${ASSISTANT_MARKER}.`,
        true,
      );
    }

    const bundlePath = `${profileDir}/electron-userdata/system-ca-bundle.pem`;
    const bundle = await checkedExec(
      defaultDaytonaExec,
      remote(provisioned.sandbox, [
        "set -euo pipefail",
        `test -s ${shellQuote(bundlePath)}`,
        `/usr/bin/openssl crl2pkcs7 -nocrl -certfile ${shellQuote(bundlePath)} | /usr/bin/openssl pkcs7 -print_certs -noout`,
      ].join("; ")),
      "inspect product-generated profile system CA bundle",
      { timeoutMs: 30_000 },
    );
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
    const encodedProbe = Buffer.from(selectiveProbe, "utf8").toString("base64");
    const selective = await checkedExec(
      defaultDaytonaExec,
      remote(
        provisioned.sandbox,
        `export NODE_EXTRA_CA_CERTS=${shellQuote(bundlePath)}; /usr/bin/env node --input-type=module -e "\$(printf %s ${shellQuote(encodedProbe)} | base64 -d)" ${shellQuote(edge.candidateUrl)} ${shellQuote(edge.negativeUrl)}`,
      ),
      "probe selective trust with product-generated CA bundle",
      { timeoutMs: 30_000 },
    );
    expect(selective.stdout).toContain('"candidate":{"ok":true,"status":200}');
    expect(selective.stdout).toContain('"negative":{"ok":false');
    evidence.recordAssertionEvidence(
      "The product-generated CA bundle contains the corporate root and grants only the candidate endpoint to a spawned Node runtime",
      `Bundle subjects include ${CORPORATE_ROOT}. Probe result: ${selective.stdout.trim()}. No TLS verification bypass was used.`,
      true,
    );

    const logged = edgeRequests((await checkedExec(
      defaultDaytonaExec,
      edge.requests,
      "read enterprise TLS edge requests",
      { timeoutMs: 30_000 },
    )).stdout);
    const candidateRequests = logged.filter((request) => request.endpoint === "trusted-candidate");
    const acceptedNegativeRoutes = logged.filter((request) => request.endpoint === "negative" && request.path.startsWith("/api/"));
    expect(candidateRequests.length).toBeGreaterThan(0);
    expect(candidateRequests.some((request) => request.path.startsWith("/api/"))).toBe(true);
    expect(acceptedNegativeRoutes).toEqual([]);
    evidence.recordAssertionEvidence(
      "The edge observed candidate control-plane traffic and accepted no negative-endpoint control-plane route",
      `Candidate requests: ${JSON.stringify(candidateRequests)}. Accepted negative API routes: ${JSON.stringify(acceptedNegativeRoutes)}.`,
      true,
    );
  } finally {
    await cleanup("remove caller-owned enterprise TLS profile", () => checkedExec(
      defaultDaytonaExec,
      ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
      `remove caller-owned profile ${profileDir}`,
      { timeoutMs: 30_000 },
    ));
    if (rootInstallAttempted) {
      await cleanup("remove enterprise TLS root", () => checkedExec(defaultDaytonaExec, edge.removeRoot, "remove enterprise TLS root", { timeoutMs: 120_000 }));
    }
    if (edgeStarted) {
      await cleanup("stop enterprise TLS edge", () => checkedExec(defaultDaytonaExec, edge.stop, "stop enterprise TLS edge", { timeoutMs: 30_000 }));
    }
    const cleanupHost = host;
    if (cleanupHost) await cleanup("dispose Daytona desktop host", () => cleanupHost[Symbol.asyncDispose]());
    if (provisioned.created) await cleanup("delete Daytona desktop sandbox", () => deleteSandboxes([provisioned.sandbox]));
  }
});
