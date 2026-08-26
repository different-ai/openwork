import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
  go,
  waitFor,
} from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import {
  eventually,
  needs,
  sleep,
  test,
} from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "rapid workspace switching through session routes opens Settings on one coherent runtime"
  : "session switching followed by Settings skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 12 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using desktopApp = await desktop({
    name: "session-switch-settings-runtime",
    host: place.host(),
  });
  const stamp = Date.now();

  const { workspaceId: firstWorkspaceId } = await createAndSelectWorkspace(desktopApp, {
    path: `/tmp/openwork-session-settings-a-${stamp}`,
  });

  await control(desktopApp, "workspace.create", {
    path: `/tmp/openwork-session-settings-b-${stamp}`,
  }, { timeoutMs: 90_000 });
  await waitFor(desktopApp, `(() => {
    const active = localStorage.getItem("openwork.react.activeWorkspace") ?? "";
    return active !== "" && active !== ${JSON.stringify(firstWorkspaceId)};
  })()`, { timeoutMs: 120_000, label: "second workspace selected" });
  const secondWorkspaceId = await evalIn(
    desktopApp,
    `localStorage.getItem("openwork.react.activeWorkspace") ?? ""`,
  );
  if (typeof secondWorkspaceId !== "string" || !secondWorkspaceId) {
    throw new Error(`workspace.create did not select a second workspace: ${JSON.stringify(secondWorkspaceId)}`);
  }

  await evalIn(desktopApp, `(() => {
    window.__sessionSettingsRuntimeErrors = [];
    window.addEventListener("error", (event) => {
      window.__sessionSettingsRuntimeErrors.push(String(event.error?.message ?? event.message ?? "window error"));
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.__sessionSettingsRuntimeErrors.push(String(event.reason?.message ?? event.reason ?? "unhandled rejection"));
    });
    return true;
  })()`);

  const firstRoute = `/workspace/${encodeURIComponent(firstWorkspaceId)}/session`;
  const secondRoute = `/workspace/${encodeURIComponent(secondWorkspaceId)}/session`;
  const switches = 24;
  for (let index = 0; index < switches; index += 1) {
    await go(desktopApp, index % 2 === 0 ? firstRoute : secondRoute);
  }

  // Hold the first Settings workspace-list response so the route can change
  // while that refresh is still in flight. The next request is allowed
  // through: the final workspace must become coherent before the stale
  // response is released.
  await evalIn(desktopApp, `(() => {
    const originalFetch = window.fetch.bind(window);
    let releaseGate = () => {};
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const state = {
      entered: false,
      released: false,
      firstCompleted: false,
      release: () => {
        if (state.released) return;
        state.released = true;
        window.fetch = originalFetch;
        releaseGate();
      },
    };
    window.__sessionSettingsRefreshGate = state;
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      let pathname = "";
      try { pathname = new URL(rawUrl, window.location.href).pathname; } catch {}
      if (!state.entered && method === "GET" && pathname === "/workspaces") {
        state.entered = true;
        await gate;
        const response = await originalFetch(input, init);
        state.firstCompleted = true;
        return response;
      }
      return originalFetch(input, init);
    };
    return true;
  })()`);

  await go(desktopApp, `/workspace/${encodeURIComponent(firstWorkspaceId)}/settings/general`);
  await waitFor(desktopApp, "window.__sessionSettingsRefreshGate?.entered === true", {
    timeoutMs: 30_000,
    label: "first Settings refresh held in flight",
  });
  await go(desktopApp, `/workspace/${encodeURIComponent(secondWorkspaceId)}/settings/general`);

  await waitFor(desktopApp, `window.location.hash.includes(${JSON.stringify(`/workspace/${encodeURIComponent(secondWorkspaceId)}/settings/general`)})
    && document.body.innerText.includes("Overview of all settings")`, {
    timeoutMs: 90_000,
    label: "routed Settings surface",
  });

  const finalRuntimeBeforeRelease = await eventually(
    () => evalIn(desktopApp, `(async () => {
      const workspaceId = ${JSON.stringify(secondWorkspaceId)};
      const desktopState = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceBootstrap");
      const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      const baseUrl = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
      const token = String(info?.ownerToken ?? info?.clientToken ?? "");
      const response = await fetch(baseUrl + "/workspaces", {
        headers: { authorization: "Bearer " + token },
      });
      const body = await response.json().catch(() => null);
      return {
        storedActiveId: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
        selectedId: String(desktopState?.selectedId ?? ""),
        watchedId: String(desktopState?.watchedId ?? ""),
        desktopActiveId: String(desktopState?.activeId ?? ""),
        serverActiveId: String(body?.activeId ?? ""),
      };
    })()`, { awaitPromise: true, timeoutMs: 20_000 }),
    {
      within: 90_000,
      intervalMs: 500,
      label: "final Settings runtime coherent before stale response release",
      until: (value) => isRecord(value)
        && value.storedActiveId === secondWorkspaceId
        && value.selectedId === secondWorkspaceId
        && value.watchedId === secondWorkspaceId
        && value.desktopActiveId === secondWorkspaceId
        && value.serverActiveId === secondWorkspaceId,
    },
  );
  evidence.recordAssertionEvidence(
    "The final Settings route becomes coherent while the previous refresh is still blocked",
    `Final runtime before releasing the stale response: ${JSON.stringify(finalRuntimeBeforeRelease)}.`,
    true,
  );

  await evalIn(desktopApp, "window.__sessionSettingsRefreshGate?.release(); true");
  await waitFor(desktopApp, "window.__sessionSettingsRefreshGate?.firstCompleted === true", {
    timeoutMs: 30_000,
    label: "stale Settings response completed",
  });
  await sleep(2_000);

  const facts = await evalIn(desktopApp, `(async () => {
    const workspaceId = ${JSON.stringify(secondWorkspaceId)};
    const firstWorkspaceId = ${JSON.stringify(firstWorkspaceId)};
    const desktopState = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceBootstrap");
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken ?? info?.clientToken ?? "");
    const headers = { authorization: "Bearer " + token };
    const readJson = async (path) => {
      const response = await fetch(baseUrl + path, { headers });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const [workspaces, firstSessions, secondSessions, config] = await Promise.all([
      readJson("/workspaces"),
      readJson("/workspace/" + encodeURIComponent(firstWorkspaceId) + "/sessions?limit=200"),
      readJson("/workspace/" + encodeURIComponent(workspaceId) + "/sessions?limit=200"),
      readJson("/workspace/" + encodeURIComponent(workspaceId) + "/config"),
    ]);
    const workspaceItems = Array.isArray(workspaces?.body?.items) ? workspaces.body.items : [];
    const selectedWorkspace = workspaceItems.find((item) => String(item?.id ?? "") === workspaceId);
    return {
      hash: window.location.hash,
      storedActiveId: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
      selectedId: String(desktopState?.selectedId ?? ""),
      watchedId: String(desktopState?.watchedId ?? ""),
      desktopActiveId: String(desktopState?.activeId ?? ""),
      serverActiveId: String(workspaces?.body?.activeId ?? ""),
      statuses: {
        workspaces: workspaces.status,
        firstSessions: firstSessions.status,
        secondSessions: secondSessions.status,
        config: config.status,
      },
      selectedOpencodeBaseUrl: String(selectedWorkspace?.opencode?.baseUrl ?? selectedWorkspace?.baseUrl ?? ""),
      responseCodes: [firstSessions, secondSessions, config]
        .map((entry) => String(entry?.body?.code ?? ""))
        .filter(Boolean),
      staleRefreshReleased: window.__sessionSettingsRefreshGate?.firstCompleted === true,
      runtimeErrors: Array.isArray(window.__sessionSettingsRuntimeErrors)
        ? [...window.__sessionSettingsRuntimeErrors]
        : [],
      visibleError: [
        "Failed to fetch",
        "OpenCode base URL is missing",
        "Workspace configuration failed",
        "Runtime error",
      ].find((message) => document.body.innerText.includes(message)) ?? null,
    };
  })()`, { awaitPromise: true, timeoutMs: 60_000 });

  if (!isRecord(facts) || !isRecord(facts.statuses)) {
    throw new Error(`Settings coherence probe returned malformed facts: ${JSON.stringify(facts)}`);
  }
  const expectedIds = {
    storedActiveId: secondWorkspaceId,
    selectedId: secondWorkspaceId,
    watchedId: secondWorkspaceId,
    desktopActiveId: secondWorkspaceId,
    serverActiveId: secondWorkspaceId,
  };
  const actualIds = {
    storedActiveId: facts.storedActiveId,
    selectedId: facts.selectedId,
    watchedId: facts.watchedId,
    desktopActiveId: facts.desktopActiveId,
    serverActiveId: facts.serverActiveId,
  };
  evidence.recordAssertionEvidence(
    "Opening Settings after the switching burst keeps every active-workspace record on the final route",
    `${switches} zero-dwell session switches ended on ${secondWorkspaceId}; active ids: ${JSON.stringify(actualIds)}.`,
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
  );
  expect(actualIds).toEqual(expectedIds);

  evidence.recordAssertionEvidence(
    "Settings and both session indexes remain readable with a configured OpenCode runtime",
    `Request statuses: ${JSON.stringify(facts.statuses)}; selected OpenCode base URL present=${String(Boolean(facts.selectedOpencodeBaseUrl))}; response codes=${JSON.stringify(facts.responseCodes)}.`,
    Object.values(facts.statuses).every((status) => status === 200)
      && facts.selectedOpencodeBaseUrl !== ""
      && Array.isArray(facts.responseCodes)
      && !facts.responseCodes.includes("opencode_unconfigured"),
  );
  expect(facts.statuses).toEqual({
    workspaces: 200,
    firstSessions: 200,
    secondSessions: 200,
    config: 200,
  });
  expect(facts.selectedOpencodeBaseUrl).not.toBe("");
  expect(facts.responseCodes).not.toContain("opencode_unconfigured");
  expect(facts.staleRefreshReleased).toBe(true);
  expect(facts.runtimeErrors).toEqual([]);
  expect(facts.visibleError).toBeNull();

});

declare global {
  interface Window {
    __sessionSettingsRuntimeErrors?: string[];
    __sessionSettingsRefreshGate?: {
      entered: boolean;
      released: boolean;
      firstCompleted: boolean;
      release: () => void;
    };
  }
}
