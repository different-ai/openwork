import { expect, onTestFinished } from "vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  clickButton,
  createOrgConnection,
  deleteConnection,
  deleteConnectionsNamed,
  evalIn,
  go,
  openConnectionsSurface,
  readAvailableModels,
  readComposerState,
  revealText,
  selectModel,
  waitFor,
  waitForConnectionCard,
  waitForText,
  writeComposerText,
} from "@openwork/behaviors";
import { app, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  model: "tool-capable",
  env: ["OPENWORK_EVAL_DEN_API_URL"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_CONNECTOR_E2E_TEST"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Cloud MCP provider capability submission skipped — needs: ${missingRequirements.join(", ")}`
  : "bundled engine provider capability proof allows an organization connector task to submit";
const modelId = process.env.OPENWORK_EVAL_MODEL?.trim() || "";

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    mocks: {
      connector: mcpMock({
        port: Number(process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PORT ?? 3979),
        publicUrl: process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL?.trim() || undefined,
      }),
    },
  });
  const connector = den.mocks.connector;
  await deleteConnectionsNamed(den.admin, "Readiness Probe ");
  const connection = await createOrgConnection(den.admin, {
    name: `Readiness Probe ${Date.now()}`,
    url: connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(den.admin, connection.id));

  await using desktopApp = await app({ den, as: "admin", place });
  await openConnectionsSurface(desktopApp, desktopApp.workspaceId);
  await waitForConnectionCard(desktopApp, connection.name, desktopApp.workspaceId);
  await waitFor(desktopApp, `(() => {
    const card = [...document.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').includes(${JSON.stringify(connection.name)}));
    card?.click();
    return Boolean(card);
  })()`, { timeoutMs: 30_000, label: "opened readiness probe connection" });
  await waitForText(desktopApp, "OAuth required", { timeoutMs: 30_000 });
  await revealText(desktopApp, "Connect your account");
  const connectClickedAt = new Date().toISOString();
  await clickButton(desktopApp, "Connect your account");
  await connector.authorizeRequestSince(connectClickedAt);
  await waitForText(desktopApp, "Connected with your own account.", { timeoutMs: 120_000 });

  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  if (modelId) {
    const models = await readAvailableModels(desktopApp);
    expect(models.some((model) => model.id === modelId && model.selectable)).toBe(true);
    await selectModel(desktopApp, modelId);
  }

  const marker = `provider-capability-${Date.now()}`;
  const prompt = `Call the mock_echo tool with text exactly "${marker}" and reply with only its result.`;
  const before = await readComposerState(desktopApp);
  await writeComposerText(desktopApp, prompt);
  await evalIn(desktopApp, `(() => {
    const originalFetch = window.fetch.bind(window);
    const probe = { originalFetch, health: null, probeRequested: false };
    window.__cloudMcpProviderCapabilityProbe = probe;
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.includes("/mcp/openwork-cloud/health")) {
        probe.probeRequested ||= url.includes("probe=1");
        const body = await response.clone().json().catch(() => null);
        if (body?.tools?.providerProjection) {
          probe.health = {
            source: body.tools.providerProjection.source,
            usableByCurrentModel: body.usableByCurrentModel,
            directChecked: body.tools.direct?.checked,
          };
        }
      }
      return response;
    };
    return true;
  })()`);
  const submittedAt = new Date().toISOString();
  await clickButton(desktopApp, "Run task");
  await waitFor(desktopApp, `(() => {
    const failed = document.querySelector('[data-testid="cloud-mcp-submission-failure"]');
    const sent = document.querySelectorAll('[data-message-role="user"]').length > ${before.userMessageCount};
    return Boolean(failed || sent);
  })()`, { timeoutMs: 60_000, label: "Cloud MCP gate completed" });
  const gate = await evalIn(desktopApp, `({
    failure: document.querySelector('[data-testid="cloud-mcp-submission-failure"]')?.textContent ?? null,
    userMessages: document.querySelectorAll('[data-message-role="user"]').length,
  })()`);
  const failure = typeof gate === "object" && gate !== null && "failure" in gate ? gate.failure : "unknown";
  const userMessages = typeof gate === "object" && gate !== null && "userMessages" in gate ? gate.userMessages : 0;
  evidence.recordAssertionEvidence(
    "The Cloud MCP submission gate accepted the bundled engine's provider capability proof",
    `Gate state: ${JSON.stringify(gate)}`,
    failure === null && typeof userMessages === "number" && userMessages > before.userMessageCount,
  );
  expect(failure).toBeNull();
  expect(userMessages).toBeGreaterThan(before.userMessageCount);

  const projectionJson = await evalIn(desktopApp, `(() => {
    const probe = window.__cloudMcpProviderCapabilityProbe;
    if (probe?.originalFetch) window.fetch = probe.originalFetch;
    delete window.__cloudMcpProviderCapabilityProbe;
    return JSON.stringify({ health: probe?.health ?? null, probeRequested: probe?.probeRequested === true });
  })()`);
  const providerCapabilityObserved = typeof projectionJson === "string"
    && projectionJson.includes('"source":"provider_capability"')
    && projectionJson.includes('"usableByCurrentModel":true')
    && projectionJson.includes('"directChecked":true')
    && projectionJson.includes('"probeRequested":true');
  evidence.recordAssertionEvidence(
    "The first-attempt health probe combined direct tools with provider tool-call capability",
    `Captured health proof: ${String(projectionJson)}`,
    providerCapabilityObserved,
  );
  expect(providerCapabilityObserved).toBe(true);

  const calls = await connector.toolCalls({ name: "mock_echo", atLeast: 1, timeoutMs: 240_000, sinceIso: submittedAt });
  const markerReachedConnector = calls.some((call) => String(call.args.text ?? "").includes(marker));
  evidence.recordAssertionEvidence(
    "The submitted organization connector task reached the provider witness",
    `Served mock_echo calls: ${JSON.stringify(calls)}`,
    markerReachedConnector,
  );
  expect(markerReachedConnector).toBe(true);

  const shot = await screenshot(desktopApp);
  const seen = await validate(shot, [
    "An OpenWork session shows a submitted task that used a connected organization tool",
    "No connected service preparation failure or crash message is visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);
});
