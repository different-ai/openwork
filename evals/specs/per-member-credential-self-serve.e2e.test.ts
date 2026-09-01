import { expect, onTestFinished } from "vitest";
import { denFetch, evalIn, fill, go, readAvailableModels, waitFor, clickButton } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, eventually, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
const ORGANIZATION_NAME = `Per-member self-serve ${RUN_ID}`;
const PROVIDER_NAME = "Member Key Provider";
const PROVIDER_KEY = "member-key-provider";
const PROVIDER_ENV = "MEMBER_KEY_PROVIDER_API_KEY";
const MODEL_ID = "member-key-model";
const MEMBER_A_EMAIL = `member-a+${RUN_ID}@example.com`;
const MEMBER_B_EMAIL = `member-b+${RUN_ID}@example.com`;
const MEMBER_A_KEY = "sk-member-a-self-serve-eval";
const BLOCKED_REPLACEMENT_KEY = "sk-member-a-blocked-replacement-eval";
const REQUEST_TIMEOUT_MS = 10_000;
const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `per-member credential self-serve skipped — needs: ${missingRequirements.join(", ")}`
  : "a member can self-serve only their own cloud provider credential from Desktop";

interface MemberCredentialFacts {
  state: string;
  version: number | null;
}

interface ProviderSyncFacts {
  materialized: boolean;
  skippedReason: string | null;
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function membershipId(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", {
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding membership for ${email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function createProvider(
  admin: DenSession,
  orgId: string,
  memberIds: string[],
): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: [PROVIDER_ENV],
        api: "https://gateway.example.com/v1",
        models: [{ id: MODEL_ID, name: "Member Key Model" }],
      },
      credentialMode: "per_member",
      allMembers: false,
      memberIds,
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating the per-member provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function deleteProvider(admin: DenSession, orgId: string, providerId: string): Promise<void> {
  await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: orgHeaders(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function memberCredential(
  admin: DenSession,
  orgId: string,
  providerId: string,
  orgMembershipId: string,
): Promise<MemberCredentialFacts> {
  const result = await denFetch(
    admin,
    `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials`,
    {
      headers: orgHeaders(admin, orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const credentials = isRecord(result.body) && Array.isArray(result.body.memberCredentials)
    ? result.body.memberCredentials.filter(isRecord)
    : [];
  const credential = credentials.find((entry) => entry.orgMembershipId === orgMembershipId);
  if (!result.response.ok || !credential || typeof credential.state !== "string") {
    throw new Error(`Reading member credential failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return {
    state: credential.state,
    version: typeof credential.version === "number" ? credential.version : null,
  };
}

async function readProviderSync(
  surface: Parameters<typeof evalIn>[0],
  providerId: string,
): Promise<ProviderSyncFacts> {
  const value = await evalIn(surface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { specError: "local server unavailable" };
    const token = String(info.ownerToken ?? info.clientToken ?? "");
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return { specError: "HTTP " + response.status + " " + (await response.text()).slice(0, 200) };
    return await response.json();
  })()`, { awaitPromise: true, timeoutMs: 40_000 });
  if (!isRecord(value) || typeof value.specError === "string") {
    throw new Error(`Reading desktop provider sync failed: ${isRecord(value) ? value.specError : "invalid response"}`);
  }
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : [];
  const skipped = Array.isArray(value.skippedProviders) ? value.skippedProviders.filter(isRecord) : [];
  const skippedProvider = skipped.find((entry) => entry.cloudProviderId === providerId);
  return {
    materialized: providers.some((entry) => entry.cloudProviderId === providerId),
    skippedReason: skippedProvider && typeof skippedProvider.reason === "string" ? skippedProvider.reason : null,
    raw: value,
  };
}

function providerRowStateExpression(status: "Needs your key" | "Connected"): string {
  return `(() => {
    const title = [...document.querySelectorAll("span")]
      .find((element) => (element.textContent ?? "").trim() === ${JSON.stringify(PROVIDER_NAME)});
    const row = title?.parentElement?.parentElement?.parentElement;
    return Boolean(row
      && (row.textContent ?? "").includes(${JSON.stringify(status)})
      && ${status === "Needs your key"
        ? `row.querySelector(${JSON.stringify(`input[aria-label="API key for ${PROVIDER_NAME}"]`)})`
        : `!row.querySelector(${JSON.stringify(`input[aria-label="API key for ${PROVIDER_NAME}"]`)})`});
  })()`;
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Credential Admin", email: `admin+${RUN_ID}@example.com` },
      members: {
        a: { name: "Member A", email: MEMBER_A_EMAIL },
        b: { name: "Member B", email: MEMBER_B_EMAIL },
      },
    },
  });
  const memberA = den.members.a;
  const memberB = den.members.b;
  if (!memberA || !memberB) throw new Error("The test organization did not provision both members.");

  const orgId = await organizationId(den.admin);
  const [memberAId, memberBId] = await Promise.all([
    membershipId(den.admin, orgId, MEMBER_A_EMAIL),
    membershipId(den.admin, orgId, MEMBER_B_EMAIL),
  ]);
  const providerId = await createProvider(den.admin, orgId, [memberAId, memberBId]);
  onTestFinished(async () => {
    await deleteProvider(den.admin, orgId, providerId).catch(() => undefined);
  });

  await using desktop = await app({ den, as: "a", place });
  const initialSync = await eventually(
    () => readProviderSync(desktop, providerId),
    {
      within: 120_000,
      intervalMs: 2_000,
      label: "member provider skipped for needs_key",
      until: (facts) => facts.skippedReason === "needs_key" && !facts.materialized,
    },
  );
  const settingsRoute = `/workspace/${desktop.workspaceId}/settings/cloud-providers`;
  await go(desktop, settingsRoute);
  await waitFor(desktop, providerRowStateExpression("Needs your key"), {
    timeoutMs: 60_000,
    label: "per-member provider needs-key row",
  });
  expect(initialSync.skippedReason).toBe("needs_key");
  evidence.recordAssertionEvidence(
    "A granted per-member provider without a binding asks this member for their key",
    `Desktop sync skipped only provider ${providerId} with reason needs_key, and Settings rendered its masked key form.`,
    initialSync.skippedReason === "needs_key" && !initialSync.materialized,
  );

  const keyInput = `input[aria-label="API key for ${PROVIDER_NAME}"]`;
  await fill(desktop, keyInput, MEMBER_A_KEY);
  await clickButton(desktop, "Save key");

  const [activeA, materialized] = await Promise.all([
    eventually(
      () => memberCredential(den.admin, orgId, providerId, memberAId),
      { within: 60_000, intervalMs: 1_000, label: "member A credential active", until: (facts) => facts.state === "active" },
    ),
    eventually(
      () => readProviderSync(desktop, providerId),
      {
        within: 120_000,
        intervalMs: 2_000,
        label: "member provider materialized after self-serve key",
        until: (facts) => facts.materialized && facts.skippedReason === null,
      },
    ),
  ]);
  const stillMissingB = await memberCredential(den.admin, orgId, providerId, memberBId);
  await waitFor(desktop, providerRowStateExpression("Connected"), {
    timeoutMs: 60_000,
    label: "per-member provider connected row",
  });
  expect(activeA.state).toBe("active");
  expect(materialized.materialized).toBe(true);
  expect(stillMissingB).toEqual({ state: "missing", version: null });
  evidence.recordAssertionEvidence(
    "Saving a member key activates and materializes the provider for that desktop",
    `Member A reached credential state active/version ${activeA.version}; sync status listed ${providerId}, and Settings showed Connected.`,
    activeA.state === "active" && materialized.materialized && materialized.skippedReason === null,
  );
  evidence.recordAssertionEvidence(
    "Member A's self-serve key does not activate Member B",
    "The admin credential-state API still reported Member B as missing with no version.",
    stillMissingB.state === "missing" && stillMissingB.version === null,
  );

  await go(desktop, `/workspace/${desktop.workspaceId}/session`);
  const models = await readAvailableModels(desktop);
  const modelMaterialized = models.some((model) => model.id === MODEL_ID && model.selectable);
  expect(modelMaterialized).toBe(true);
  evidence.recordAssertionEvidence(
    "The materialized provider contributes its model to the running engine",
    `The model picker exposed selectable model ${MODEL_ID}.`,
    modelMaterialized,
  );
  await evalIn(desktop, `(() => {
    const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (close instanceof HTMLElement) close.click();
    return true;
  })()`);
  await go(desktop, settingsRoute);
  await waitFor(desktop, providerRowStateExpression("Connected"), {
    timeoutMs: 60_000,
    label: "connected provider before admin block",
  });

  const block = await denFetch(
    den.admin,
    `/v1/llm-providers/${encodeURIComponent(providerId)}/member-credentials/${encodeURIComponent(memberAId)}/block`,
    {
      method: "POST",
      headers: orgHeaders(den.admin, orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  expect(block.response.status).toBe(200);
  const blockedPayload = isRecord(block.body) ? block.body : {};
  const blockedVersion = typeof blockedPayload.version === "number" ? blockedPayload.version : null;
  expect(blockedPayload.state).toBe("blocked");
  expect(blockedVersion).not.toBeNull();

  await clickButton(desktop, "Sync now");
  await eventually(
    () => readProviderSync(desktop, providerId),
    {
      within: 120_000,
      intervalMs: 2_000,
      label: "blocked member provider returns to needs_key",
      until: (facts) => facts.skippedReason === "needs_key" && !facts.materialized,
    },
  );
  await waitFor(desktop, providerRowStateExpression("Needs your key"), {
    timeoutMs: 60_000,
    label: "blocked provider key form",
  });
  await fill(desktop, keyInput, BLOCKED_REPLACEMENT_KEY);
  await clickButton(desktop, "Save key");
  await waitFor(desktop, `(() => {
    const alert = document.querySelector('[role="alert"]');
    const input = document.querySelector(${JSON.stringify(keyInput)});
    return Boolean(alert?.textContent?.includes("An admin manages this credential")
      && input instanceof HTMLInputElement
      && input.value === ""
      && !document.body.innerText.includes(${JSON.stringify(BLOCKED_REPLACEMENT_KEY)}));
  })()`, { timeoutMs: 30_000, label: "admin-managed blocked credential error" });

  const stillBlockedA = await memberCredential(den.admin, orgId, providerId, memberAId);
  expect(stillBlockedA).toEqual({ state: "blocked", version: blockedVersion });
  evidence.recordAssertionEvidence(
    "An admin block stays authoritative when the member tries another key",
    `Settings showed the inline admin-managed error, cleared the masked input, and Den kept state blocked/version ${blockedVersion}.`,
    stillBlockedA.state === "blocked" && stillBlockedA.version === blockedVersion,
  );
});
