import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DynamicToolUIPart } from "ai";

GlobalRegistrator.register({ url: "https://desktop.example" });
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { parseAutomationProposal } = await import("../src/components/tools/openwork-automation-proposal");
const { MessageList } = await import("../src/components/chat/message-list");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const availability = await import("../src/react-app/domains/automations/automation-availability");
const den = await import("../src/app/lib/den");

const dailyProposal = {
  ok: true,
  id: "automation.propose",
  result: {
    ok: true,
    kind: "automation-proposal",
    created: false,
    proposal: {
      name: "Morning Slack check",
      instructions: "Summarize my most recent Slack message.",
      schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
    },
  },
};

describe("Automation proposal card", () => {
  test.each([true, false])("chat keeps functional proposal review with deployment enabled: %s", async enabled => {
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    queryClient.setQueryData(["den", "automations", "org_fixture", "models"], []);
    const settings = den.readDenSettings();
    const settingsSpy = spyOn(den, "readDenSettings").mockReturnValue({ ...settings, baseUrl: "https://den.example", authToken: "fixture-token", activeOrgId: "org_fixture" });
    const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: null, verifiedIdentity: { principalId: "member_fixture", organizationId: "org_fixture" }, isSignedIn: true, error: null, refresh: async () => {} });
    const enabledSpy = spyOn(availability, "useAutomationDeploymentEnabled").mockReturnValue(enabled);
    const placementSpy = spyOn(availability, "automationCreationPlacement").mockReturnValue("desktop");
    const writes: unknown[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/v1/automations") || init?.method !== "POST" || typeof init.body !== "string") throw new Error(`Unexpected request: ${url}`);
      writes.push(JSON.parse(init.body));
      return Response.json({ automation: { id: "atm_fixture" } });
    });
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork_execute", toolCallId: "proposal", state: "output-available",
      input: { id: "automation.propose" },
      output: { ...dailyProposal, result: { ...dailyProposal.result, proposal: { ...dailyProposal.result.proposal, workspaceId: "untrusted-workspace" } } },
    };
    const noop = () => {};
    try {
      await act(async () => root.render(createElement(PlatformProvider, {
        value: createDefaultPlatform(), children: createElement(QueryClientProvider, {
          client: queryClient, children: createElement(MemoryRouter, {
            children: createElement(WorkspaceProvider, {
              client: null, openworkServerClient: null, workspaceId: "origin-workspace", selectedWorkspaceRoot: "/fixture",
              children: createElement(MessageListProvider, {
                workspaceId: "origin-workspace", sessionId: "origin-session", showThinking: false, developerMode: false,
                displaySuggestions: false, providerConnectedCount: 1, dispatchAction: noop, setPrompt: noop,
                onRevertToUserMessage: noop, onForkAtMessage: noop, onEditUserMessage: noop,
                onMcpReconnect: async () => "connected", onMcpReopenAuthorization: async () => {},
                children: createElement(MessageList, { messages: [{ id: "proposal-message", role: "assistant", parts: [part] }], status: "ready" }),
              }),
            }),
          }),
        }),
      })));
      expect(container.querySelector("[data-openwork-automation-proposal]")).not.toBeNull();
      expect(container.textContent).toContain("Nothing was created yet. Review it");
      expect(container.textContent).toContain(dailyProposal.result.proposal.name);
      expect(container.textContent).toContain(dailyProposal.result.proposal.instructions);
      expect(container.querySelector('[data-capability-call="openwork_execute"]')).toBeNull();
      expect(writes).toEqual([]);
      const create = container.querySelector<HTMLButtonElement>("[data-create-automation]");
      if (!create) throw new Error("Missing Create Automation review action");
      expect(create.disabled).toBe(!enabled);
      await act(async () => create.click());
      if (enabled) {
        expect(writes).toEqual([expect.objectContaining({
          name: dailyProposal.result.proposal.name,
          instructions: dailyProposal.result.proposal.instructions,
          schedule: dailyProposal.result.proposal.schedule,
          workspaceId: "origin-workspace",
        })]);
        expect(container.querySelector('[data-automation-created="atm_fixture"]')).not.toBeNull();
        expect(container.querySelector('[data-open-automation="atm_fixture"]')).not.toBeNull();
        expect(container.textContent).toContain("while this desktop is connected");
      } else {
        expect(writes).toEqual([]);
        expect(container.textContent).toContain("Automations are disabled for this deployment.");
      }
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
      for (const spy of [settingsSpy, authSpy, enabledSpy, placementSpy, fetchSpy]) spy.mockRestore();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test("reads a proposal out of an openwork_execute result, string or object", () => {
    const fromObject = parseAutomationProposal(dailyProposal);
    const fromString = parseAutomationProposal(JSON.stringify(dailyProposal));

    expect(fromObject).toEqual(fromString);
    expect(fromObject?.name).toBe("Morning Slack check");
    expect(fromObject?.schedule).toEqual({
      kind: "daily",
      timezone: "Europe/Berlin",
      hour: 9,
      minute: 0,
    });
    expect(fromObject?.model).toBeUndefined();
  });

  test("ignores results that are not Automation proposals", () => {
    expect(parseAutomationProposal({ ...dailyProposal, id: "session.create" })).toBeNull();
    expect(parseAutomationProposal({ ...dailyProposal, ok: false })).toBeNull();
    expect(parseAutomationProposal("not json")).toBeNull();
    expect(parseAutomationProposal(null)).toBeNull();
  });

  test("refuses a proposal whose schedule or fields fail the shared contract", () => {
    const badSchedule = {
      ...dailyProposal,
      result: {
        ...dailyProposal.result,
        proposal: {
          ...dailyProposal.result.proposal,
          schedule: { kind: "interval", timezone: "Europe/Berlin", everyMinutes: 5 },
        },
      },
    };
    const emptyName = {
      ...dailyProposal,
      result: {
        ...dailyProposal.result,
        proposal: { ...dailyProposal.result.proposal, name: "   " },
      },
    };

    expect(parseAutomationProposal(badSchedule)).toBeNull();
    expect(parseAutomationProposal(emptyName)).toBeNull();
  });
});
