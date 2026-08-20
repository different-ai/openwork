import { expect } from "vitest";
import { createOrgConnection, evalIn, waitFor } from "@openwork/behaviors";
import { app, eventually, faultProxy, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library Advanced settings refresh skipped — needs: ${missingRequirements.join(", ")}`
  : "Library keeps Advanced settings expanded through server inventory refresh";
const orgConnectionsPath = "/api/den/v1/mcp-connections";
const capabilitiesPath = "/api/den/v1/resources/marketplace-capabilities";

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Library Advanced refresh ${Date.now()}`,
      admin: { name: "Library Refresh Admin" },
    },
    mocks: { connector: mcpMock() },
  });
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  });
  await using desktop = await app({ den: { ...den, ref: proxy.ref }, as: "admin", place });
  const settingsHash = `#/workspace/${desktop.workspaceId}/settings/extensions`;
  const committedSettingsRoute = `(() => {
    const target = ${JSON.stringify(settingsHash)};
    const committed = window.location.hash === target
      && !document.querySelector("[data-extensions-main-surface]")
      && [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.trim() === "Back to app")
      && [...document.querySelectorAll("h1, h2")]
        .some((heading) => heading.textContent?.trim() === "Library")
      && [...document.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").includes("Advanced settings"));
    if (!committed && window.location.hash !== target) window.location.hash = target;
    return committed;
  })()`;

  await waitFor(desktop, committedSettingsRoute, {
    timeoutMs: 90_000,
    label: "committed Settings Library route",
  });

  const initialRequests = await eventually(
    () => proxy.requestLog(),
    {
      within: 60_000,
      intervalMs: 500,
      label: "initial server inventory requests",
      until: (requests) => [orgConnectionsPath, capabilitiesPath].every((path) =>
        requests.some((request) => request.method === "GET"
          && request.path.startsWith(path)
          && request.status === 200)),
    },
  );
  const initialOrgConnectionRequests = initialRequests.filter((request) => request.method === "GET"
    && request.path.startsWith(orgConnectionsPath)).length;
  const initialCapabilityRequests = initialRequests.filter((request) => request.method === "GET"
    && request.path.startsWith(capabilitiesPath)).length;
  expect(initialOrgConnectionRequests).toBeGreaterThan(0);
  expect(initialCapabilityRequests).toBeGreaterThan(0);
  await waitFor(desktop, committedSettingsRoute, {
    timeoutMs: 30_000,
    label: "stable Settings Library route before expanding Advanced settings",
  });

  const expanded = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").includes("Advanced settings"));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(expanded).toBe(true);
  await waitFor(desktop, `[...document.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === "Add workspace MCP")`, {
    timeoutMs: 10_000,
    label: "expanded Add workspace MCP action",
  });
  const probeInstalled = await evalIn(desktop, `(() => {
    const visible = () => {
      const button = [...document.querySelectorAll("button")]
        .find((entry) => entry.textContent?.trim() === "Add workspace MCP");
      if (!(button instanceof HTMLButtonElement)) return false;
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== "hidden";
    };
    const probe = { everMissing: !visible(), samples: 1 };
    const observer = new MutationObserver(() => {
      probe.samples += 1;
      if (!visible()) probe.everMissing = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.__openworkAdvancedRefreshProbe = { observer, probe, visible };
    return visible();
  })()`);
  expect(probeInstalled).toBe(true);

  const connectionName = `Advanced refresh connection ${Date.now()}`;
  await createOrgConnection(den.admin, {
    name: connectionName,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  await Promise.all([
    proxy.faults.latency(orgConnectionsPath, 3_000, { times: 1 }),
    proxy.faults.latency(capabilitiesPath, 3_000, { times: 1 }),
  ]);
  const refreshClicked = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => entry.textContent?.trim() === "Refresh" && !entry.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(refreshClicked).toBe(true);

  const refreshedRequests = await eventually(
    () => proxy.requestLog(),
    {
      within: 60_000,
      intervalMs: 500,
      label: "delayed successful server inventory refresh requests",
      until: (requests) => {
        const orgRequests = requests.filter((request) => request.method === "GET"
          && request.path.startsWith(orgConnectionsPath));
        const capabilityRequests = requests.filter((request) => request.method === "GET"
          && request.path.startsWith(capabilitiesPath));
        return orgRequests.length > initialOrgConnectionRequests
          && capabilityRequests.length > initialCapabilityRequests
          && orgRequests.at(-1)?.status === 200
          && orgRequests.at(-1)?.faulted === true
          && capabilityRequests.at(-1)?.status === 200
          && capabilityRequests.at(-1)?.faulted === true;
      },
    },
  );
  const refreshedOrgConnectionRequest = refreshedRequests.filter((request) => request.method === "GET"
    && request.path.startsWith(orgConnectionsPath)).at(-1);
  const refreshedCapabilityRequest = refreshedRequests.filter((request) => request.method === "GET"
    && request.path.startsWith(capabilitiesPath)).at(-1);
  expect(refreshedOrgConnectionRequest).toMatchObject({ status: 200, faulted: true });
  expect(refreshedCapabilityRequest).toMatchObject({ status: 200, faulted: true });

  await waitFor(desktop, `document.body.innerText.includes(${JSON.stringify(connectionName)})`, {
    timeoutMs: 30_000,
    label: "new organization connection rendered from refreshed inventory",
  });
  const stayedExpanded = await evalIn(desktop, `(() => {
    const current = window.__openworkAdvancedRefreshProbe;
    if (!current) return false;
    current.observer.disconnect();
    return current.probe.samples > 1 && !current.probe.everMissing && current.visible();
  })()`);
  expect(stayedExpanded).toBe(true);
  evidence.recordAssertionEvidence(
    "Advanced settings stays expanded through real server inventory refreshes",
    `Refresh completed delayed HTTP 200 requests for ${refreshedOrgConnectionRequest?.path} and ${refreshedCapabilityRequest?.path}, rendered ${connectionName}, and Add workspace MCP never disappeared.`,
    refreshedOrgConnectionRequest?.status === 200
      && refreshedOrgConnectionRequest.faulted
      && refreshedCapabilityRequest?.status === 200
      && refreshedCapabilityRequest.faulted
      && stayedExpanded === true,
  );
});
