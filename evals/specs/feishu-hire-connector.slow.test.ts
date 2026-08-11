import { createServer } from "node:http";
import { expect } from "vitest";
import { denFetch, evalIn, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

const requirements: NeedsSpec = {
  optIn: ["OPENWORK_EVAL_APP_SPECS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Feishu Hire connector skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin adds Feishu Hire and agents can discover its read-only recruiting tools";

let requestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function toolText(result: unknown): string {
  const record = requireRecord(result, "MCP tool result");
  const first = Array.isArray(record.content) ? record.content[0] : null;
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error(`MCP tool result had no text content: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return first.text;
}

async function organizationIdOf(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function callAgentTool(
  apiUrl: string,
  token: string,
  name: "search_capabilities" | "execute_capability",
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP search failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP search returned no SSE data frame: ${raw.slice(0, 500)}`);
  const payload = requireRecord(JSON.parse(dataLine.slice(5)), "MCP JSON-RPC payload");
  if (payload.error) throw new Error(`MCP search returned JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return requireRecord(JSON.parse(toolText(requireRecord(payload.result, "MCP result"))), `${name} payload`);
}

async function startFeishuHireMock(): Promise<AsyncDisposable> {
  const previousApiBaseUrl = process.env.DEN_FEISHU_HIRE_API_BASE_URL;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const send = (payload: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
      send({ code: 0, tenant_access_token: "eval-tenant-token", expire: 7200 });
      return;
    }
    if (path === "/open-apis/hire/v1/applications") {
      send({ code: 0, data: { items: ["application-eval-1"], has_more: false } });
      return;
    }
    if (path === "/open-apis/hire/v1/applications/application-eval-1") {
      send({ code: 0, data: { application: {
        talent_id: "talent-eval-1",
        job_id: "job-eval-1",
        stage: { id: "stage-eval-1", en_name: "Interview", type: 2 },
        active_status: 1,
        create_time: "1720000000",
        modify_time: "1720000100",
      } } });
      return;
    }
    if (path === "/open-apis/hire/v2/talents/talent-eval-1") {
      send({ code: 0, data: { talent: {
        id: "talent-eval-1",
        basic_info: {
          name: "Candidate Lin",
          mobile: "13800000000",
          email: "candidate@example.com",
          birthday: "1990-01-01",
          current_city: { en_name: "Shanghai" },
        },
        identification: { id_number: "sensitive-identity-number" },
        address: "sensitive-home-address",
        marital_status: 1,
      } } });
      return;
    }
    send({ code: 404 }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Feishu Hire mock did not bind a TCP port.");
  process.env.DEN_FEISHU_HIRE_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  return {
    async [Symbol.asyncDispose]() {
      if (previousApiBaseUrl === undefined) delete process.env.DEN_FEISHU_HIRE_API_BASE_URL;
      else process.env.DEN_FEISHU_HIRE_API_BASE_URL = previousApiBaseUrl;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function replaceInput(browserExpressionName: string, value: string, browser: Awaited<ReturnType<typeof chrome>>) {
  const replaced = await evalIn(browser, `(() => {
    const input = document.querySelector('[name="${browserExpressionName}"]');
    if (!(input instanceof HTMLInputElement)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return null;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
  expect(replaced).toBe(value);
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using _feishuHireMock = await startFeishuHireMock();
  await using den = await server({
    place,
    org: {
      name: `Feishu Hire Eval ${Date.now()}`,
      admin: { name: "Sarah" },
    },
  });

  await using browser = await chrome({
    name: "feishu-hire-connector",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/mcp-connections`);
  await waitFor(browser, `(() => {
    const card = document.querySelector('[data-testid="quick-add-feishu-hire"]');
    const text = card?.textContent ?? "";
    return Boolean(card) && text.includes("Feishu Hire") && text.includes("candidates") && text.includes("Guided setup");
  })()`, { timeoutMs: 60_000, label: "Feishu Hire quick-add card" });
  const cardVisible = await evalIn(browser, `Boolean(document.querySelector('[data-testid="quick-add-feishu-hire"]'))`);
  const docsCardAbsent = await evalIn(browser, `!document.querySelector('[data-testid="quick-add-feishu-docs"]')`);
  expect(cardVisible).toBe(true);
  expect(docsCardAbsent).toBe(true);
  evidence.fact(
    "Feishu Hire appears as a distinct workspace-suite connector",
    `Feishu Hire card visible: ${String(cardVisible)}; no misleading Feishu Docs card: ${String(docsCardAbsent)}.`,
    cardVisible === true && docsCardAbsent === true,
  );

  const opened = await evalIn(browser, `(() => {
    const card = document.querySelector('[data-testid="quick-add-feishu-hire"]');
    if (!(card instanceof HTMLButtonElement)) return false;
    card.click();
    return true;
  })()`);
  expect(opened).toBe(true);
  await waitFor(browser, `(() => {
    const dialog = document.querySelector('[data-testid="feishu-hire-dialog"]');
    const text = dialog?.textContent ?? "";
    return Boolean(dialog)
      && Boolean(document.querySelector('[name="feishu-hire-app-id"]'))
      && Boolean(document.querySelector('[name="feishu-hire-app-secret"]'))
      && Boolean(document.querySelector('[name="feishu-hire-url"]'))
      && text.includes("hire:job:readonly")
      && text.includes("hire:talent:readonly")
      && text.includes("hire:application:readonly");
  })()`, { timeoutMs: 30_000, label: "Feishu Hire guided setup dialog" });
  const secretNotInPage = await evalIn(browser, `!document.body.innerText.includes("eval-feishu-secret")`);
  expect(secretNotInPage).toBe(true);
  evidence.fact(
    "Setup asks for the tenant URL and app credentials while disclosing only three read-only permissions",
    "The dialog showed tenant URL, App ID, App Secret, and the job, talent, and application readonly scopes.",
    secretNotInPage === true,
  );

  await replaceInput("feishu-hire-name", "Feishu Hire", browser);
  await replaceInput("feishu-hire-url", "https://eval-example.feishu.cn/hire", browser);
  await replaceInput("feishu-hire-app-id", "cli_eval_feishu_hire", browser);
  await replaceInput("feishu-hire-app-secret", "eval-feishu-secret", browser);
  const submitted = await evalIn(browser, `(() => {
    const button = document.querySelector('[data-testid="save-feishu-hire"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(submitted).toBe(true);
  await waitFor(browser, `(() => {
    const card = document.querySelector('[data-testid="quick-add-feishu-hire"]');
    const text = card?.textContent ?? "";
    return !document.querySelector('[data-testid="feishu-hire-dialog"]')
      && text.includes("Added")
      && text.includes("Manage")
      && !document.body.innerText.includes("eval-feishu-secret");
  })()`, { timeoutMs: 60_000, label: "configured Feishu Hire card without secret disclosure" });
  const configuredCard = await evalIn(browser, `(() => {
    const text = document.querySelector('[data-testid="quick-add-feishu-hire"]')?.textContent ?? "";
    return text.includes("Added") && text.includes("Manage");
  })()`);
  expect(configuredCard).toBe(true);
  evidence.fact(
    "Saving the app credentials adds the organization-managed connector without rendering its secret",
    `Added and Manage are visible: ${String(configuredCard)}; saved secret is absent from the page.`,
    configuredCard === true,
  );

  const orgId = await organizationIdOf(den.admin);
  const mcpToken = await mintMcpToken(den.admin, orgId);
  const search = await callAgentTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "Feishu Hire candidates jobs applications",
    limit: 10,
  });
  const matches = Array.isArray(search.matches) ? search.matches.filter(isRecord) : [];
  const serializedMatches = JSON.stringify(matches);
  const capabilityNames = matches.flatMap((match) => typeof match.name === "string" ? [match.name] : []);
  expect(capabilityNames.some((name) => name.includes("feishu-hire") && name.includes("Jobs"))).toBe(true);
  expect(capabilityNames.some((name) => name.includes("feishu-hire") && name.includes("Talents"))).toBe(true);
  expect(capabilityNames.some((name) => name.includes("feishu-hire") && name.includes("Applications"))).toBe(true);
  expect(serializedMatches).not.toContain("eval-feishu-secret");
  expect(serializedMatches).not.toContain("cli_eval_feishu_hire");
  evidence.fact(
    "Agents discover read-only Feishu Hire jobs, talents, and applications through OpenWork Connect",
    `Discovered capability names: ${capabilityNames.filter((name) => name.includes("feishu-hire")).join(", ")}. Credentials were absent.`,
    capabilityNames.some((name) => name.includes("Jobs"))
      && capabilityNames.some((name) => name.includes("Talents"))
      && capabilityNames.some((name) => name.includes("Applications"))
      && !serializedMatches.includes("eval-feishu-secret"),
  );

  const applicationsCapability = capabilityNames.find((name) => name.includes("feishu-hireApplications"));
  expect(applicationsCapability).toBeTruthy();
  const applicationResult = await callAgentTool(den.ref.apiUrl, mcpToken, "execute_capability", {
    name: applicationsCapability,
    query: { pageSize: 1 },
  });
  const serializedApplications = JSON.stringify(applicationResult);
  expect(serializedApplications).toContain("Candidate Lin");
  expect(serializedApplications).toContain("https://eval-example.feishu.cn/talent/talent-eval-1?application_id=application-eval-1");
  for (const sensitiveValue of [
    "13800000000",
    "candidate@example.com",
    "1990-01-01",
    "sensitive-identity-number",
    "sensitive-home-address",
    "eval-feishu-secret",
    "cli_eval_feishu_hire",
    "eval-tenant-token",
  ]) {
    expect(serializedApplications).not.toContain(sensitiveValue);
  }
  evidence.fact(
    "Application results link back to Feishu Hire without exposing sensitive candidate or credential fields",
    "The executed application capability returned Candidate Lin and a tenant deep link; contact, identity, address, birth date, app credentials, and tenant token were absent.",
    serializedApplications.includes("Candidate Lin")
      && serializedApplications.includes("https://eval-example.feishu.cn/talent/talent-eval-1?application_id=application-eval-1")
      && !serializedApplications.includes("candidate@example.com")
      && !serializedApplications.includes("sensitive-identity-number")
      && !serializedApplications.includes("eval-feishu-secret"),
  );

});
