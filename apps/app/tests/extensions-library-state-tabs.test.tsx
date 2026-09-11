import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PluginsExtensionsStore } from "../src/react-app/domains/settings/pages/plugins-view";
import type { ExtensionInventoryGroup } from "../src/react-app/domains/settings/extension-items";
import { readExtensionLayout, writeExtensionLayout } from "../src/react-app/domains/settings/extension-state";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI detects DOM support at import time, including for portals and focus.
const { createRoot } = await import("react-dom/client");
const { ExtensionsView, filterForSection, stateForSection } = await import("../src/react-app/domains/settings/pages/extensions-view");
const { TooltipProvider } = await import("../src/components/ui/tooltip");
const { LibraryAddControl, libraryAddKindLabel } = await import("../src/react-app/domains/settings/pages/library-add-control");
const {
  connectMcpInventoryGroup,
  countInventoryCardGroups,
  ExtensionStateTabs,
  filterInventoryCardsByState,
  LibraryEmptyState,
  LibraryStatusWarning,
  McpAdvancedConfigSection,
  McpQuickConnectSection,
} = await import("../src/react-app/domains/settings/pages/mcp-view");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  window.localStorage.clear();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}

const extensions: PluginsExtensionsStore = {
  pluginScope: "project",
  setPluginScope: () => {},
  refreshPlugins: () => {},
  pluginConfigPath: () => null,
  pluginConfig: () => null,
  pluginList: () => [],
  pluginInput: () => "",
  setPluginInput: () => {},
  pluginStatus: () => null,
  addPlugin: () => {},
  removePlugin: () => {},
  isPluginInstalledByName: () => false,
  activePluginGuide: () => null,
  setActivePluginGuide: () => {},
};

describe("Library state tabs", () => {
  test("renders the Ready to use count without a connected-app chip", () => {
    const counts = countInventoryCardGroups([
      "ready",
      "needs_signin",
      "ready",
      "needs_admin_setup",
      "ready",
    ]);
    const html = renderToStaticMarkup(
      <ExtensionsView
        busy={false}
        selectedWorkspaceRoot="/workspace"
        isRemoteWorkspace={false}
        canEditPlugins
        canUseGlobalScope
        suggestedPlugins={[]}
        extensions={extensions}
        onRefresh={() => {}}
        mcpView={() => (
          <ExtensionStateTabs
            state="ready"
            needsSigninCount={counts.needs_signin}
            needsAdminSetupCount={counts.needs_admin_setup}
            readyCount={counts.ready}
            onChange={() => {}}
          />
        )}
      />,
    );

    expect(html).not.toContain("Skills, commands, agents, connections, and tools your agent can use.");
    expect(html).toContain("Ready to use");
    expect(html).toContain(">3</span>");
    expect(html.toLowerCase()).not.toContain("app connected");
    expect(html.toLowerCase()).not.toContain("apps connected");
    expect(html).not.toContain(">All<");
    expect(html.indexOf("Ready to use")).toBeLessThan(html.indexOf("Needs your sign-in"));
  });

  test("selecting Ready filters the assembled cards to ready rows", () => {
    const cards: Array<{ name: string; group: ExtensionInventoryGroup }> = [
      { name: "Local skill", group: "ready" },
      { name: "Calendar", group: "needs_signin" },
      { name: "Installed plugin", group: "ready" },
    ];

    expect(filterInventoryCardsByState(cards, "ready")).toEqual([
      cards[0],
      cards[2],
    ]);
  });

  test("defaults legacy entry routes to MCPs and Ready without dropping command/agent routes", () => {
    expect(filterForSection(undefined)).toBe("mcp");
    expect(filterForSection("connections")).toBe("mcp");
    expect(stateForSection(undefined)).toBe("ready");
    expect(stateForSection("needs-sign-in")).toBe("needs_signin");
    expect(filterForSection("commands")).toBe("command");
    expect(filterForSection("agents")).toBe("agent");
  });

  test("cards are the initial layout, retaining an explicit saved list choice", () => {
    expect(readExtensionLayout()).toBe("grid");
    writeExtensionLayout("list");
    expect(readExtensionLayout()).toBe("list");
    writeExtensionLayout("grid");
    expect(readExtensionLayout()).toBe("grid");
    window.localStorage.setItem("openwork.extensions.layout", "obsolete");
    expect(readExtensionLayout()).toBe("grid");
  });

  test("Ready remains selectable at zero and all problem states have distinct tabs", async () => {
    const onChange = mock(() => {});
    const host = await mount(<ExtensionStateTabs state="ready" readyCount={0} needsSigninCount={2} needsAdminSetupCount={1} availableCount={1} disabledCount={1} onChange={onChange} />);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(5);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].textContent).toContain("Ready to use");
    await act(async () => tabs[3].click());
    expect(onChange).toHaveBeenCalledWith("available");
    await act(async () => tabs[4].click());
    expect(onChange).toHaveBeenCalledWith("disabled");
    expect(countInventoryCardGroups(["available", "disabled"]).ready).toBe(0);
  });

  test("Cloud MCP status does not label setup failures or disabled servers as sign-in", () => {
    const entry = { name: "Calendar", config: { type: "remote", url: "https://calendar.example/mcp" } };
    expect(connectMcpInventoryGroup(entry, { Calendar: { status: "needs_auth" } })).toBe("needs_signin");
    expect(connectMcpInventoryGroup(entry, { Calendar: { status: "failed", error: "unavailable" } })).toBe("available");
    expect(connectMcpInventoryGroup(entry, { Calendar: { status: "disabled" } })).toBe("disabled");
  });

  test("assembled Ready cards exclude disconnected Cloud MCPs without losing their count", async () => {
    const onCounts = mock(() => {});
    const host = await mount(<McpQuickConnectSection
      skillCount={0} entries={[]} loading={false} layout="grid" filter="mcp" state="ready"
      availableConnectMcpServers={[
        { name: "Ready MCP", config: { type: "remote", url: "https://ready.example/mcp" } },
        { name: "Sign-in MCP", config: { type: "remote", url: "https://signin.example/mcp" } },
      ]}
      availableConnectMcpStatuses={{ "Ready MCP": { status: "connected" }, "Sign-in MCP": { status: "needs_auth" } }}
      onStateCountsChange={onCounts} busy={false} connectingName={null}
      isEntryHidden={() => false} isSkillHidden={() => false} isPluginHidden={() => false}
      disabledReasonForEntry={() => null} isConfigured={() => false} statusForEntry={() => undefined}
      onConnect={() => {}} onDetail={() => {}} orgMcpDisconnectingId={null}
    />);
    expect(host.textContent).toContain("Ready MCP");
    expect(host.textContent).not.toContain("Sign-in MCP");
    expect(onCounts).toHaveBeenCalledWith({ ready: 1, needs_signin: 1, needs_admin_setup: 0, available: 0, disabled: 0 });
  });

  test.each([
    ["mcp", "No MCPs yet", "Add MCP"],
    ["skill", "No skills yet", "Create skill"],
    ["plugin", "No plugins yet", "Add plugin"],
  ] as const)("%s empty state offers the matching creation action", async (filter, title, label) => {
    const onAdd = mock(() => {});
    const host = await mount(<LibraryEmptyState filter={filter} state="ready" counts={countInventoryCardGroups([])} searching={false} onAdd={onAdd} onClearSearch={() => {}} onStateChange={() => {}} />);
    expect(host.textContent).toContain(title);
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  test("Ready-empty offers sign-in items instead of claiming the category is empty", async () => {
    const onChange = mock(() => {});
    const host = await mount(<LibraryEmptyState filter="mcp" state="ready" counts={countInventoryCardGroups(["needs_signin"])} searching={false} onClearSearch={() => {}} onStateChange={onChange} />);
    expect(host.textContent).toContain("No MCPs ready to use");
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    expect(onChange).toHaveBeenCalledWith("needs_signin");
  });

  test("search-empty clears filters rather than offering another install", async () => {
    const onClear = mock(() => {});
    const onAdd = mock(() => {});
    const host = await mount(<LibraryEmptyState filter="skill" state="ready" counts={countInventoryCardGroups(["ready"])} searching onAdd={onAdd} onClearSearch={onClear} onStateChange={() => {}} />);
    expect(host.textContent).toContain("No library items match");
    expect(host.textContent).not.toContain("Create skill");
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("unavailable Cloud is distinct from a genuinely empty Library", async () => {
    const refresh = mock(() => {});
    const host = await mount(<LibraryEmptyState filter="mcp" state="ready" counts={countInventoryCardGroups([])} searching={false} error="Inventory could not be loaded" onRefresh={refresh} onClearSearch={() => {}} onStateChange={() => {}} />);
    expect(host.textContent).toContain("OpenWork Cloud is unavailable");
    expect(host.textContent).toContain("Inventory could not be loaded");
    expect(host.textContent).not.toContain("No MCPs yet");
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("header Add is icon-only, named, and does not bypass a disabled setup policy", async () => {
    const select = mock(() => {});
    const host = await mount(<LibraryAddControl kinds={["mcp"]} iconOnly disabledReason="Ask your admin" onSelect={select} />);
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Add MCP"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("");
    expect(button?.querySelector("svg")?.getAttribute("width")).toBe("20");
    await act(async () => button?.click());
    expect(select).not.toHaveBeenCalled();
  });

  test("Library Add distinguishes cloud and workspace MCP labels", () => {
    expect(libraryAddKindLabel("mcp")).toBe("Add MCP");
    expect(libraryAddKindLabel("workspace-mcp")).toBe("Add workspace MCP");
  });

  test("member header and empty-state actions describe browsing available MCPs", async () => {
    const select = mock(() => {});
    const browse = mock(() => {});
    const header = await mount(<LibraryAddControl kinds={["mcp"]} iconOnly label="View available MCPs" onSelect={select} />);
    const empty = await mount(<LibraryEmptyState filter="mcp" state="ready" counts={countInventoryCardGroups([])} searching={false} addLabel="View available MCPs" onAdd={browse} onClearSearch={() => {}} onStateChange={() => {}} />);
    const headerAction = header.querySelector<HTMLButtonElement>('button[aria-label="View available MCPs"]');
    const emptyAction = empty.querySelector<HTMLButtonElement>('button[aria-label="View available MCPs"]');
    expect(headerAction).not.toBeNull();
    expect(headerAction?.textContent).toBe("");
    expect(emptyAction?.textContent).toContain("View available MCPs");
    await act(async () => { headerAction?.click(); emptyAction?.click(); });
    expect(select).toHaveBeenCalledWith("mcp");
    expect(browse).toHaveBeenCalledTimes(1);
  });

  test("Advanced owns workspace setup and hides it when closed or policy denies it", () => {
    const base = { configScope: "project", activeConfig: null, canRevealConfig: false, revealBusy: false, revealLabel: "Open file", configError: null, onToggle: () => {}, onScopeChange: () => {}, onReveal: async () => {} } as const;
    const closed = renderToStaticMarkup(<McpAdvancedConfigSection {...base} open={false} onAddMcp={() => {}}><div>Local server</div></McpAdvancedConfigSection>);
    expect(closed).not.toContain("Add workspace MCP");
    expect(closed).not.toContain("Local server");
    const open = renderToStaticMarkup(<McpAdvancedConfigSection {...base} open onAddMcp={() => {}}><div>Local server</div></McpAdvancedConfigSection>);
    expect(open).toContain("Add workspace MCP");
    expect(open).toContain("Local server");
    const restricted = renderToStaticMarkup(<McpAdvancedConfigSection {...base} open />);
    expect(restricted).not.toContain("Add workspace MCP");
  });

  test("warning is conditional, keyboard-focusable, preserves guidance, and Escape dismisses it", async () => {
    const warning = "Some MCPs could not be registered with the engine: Calendar, Notes. They may appear disconnected - try reloading the engine.";
    expect(renderToStaticMarkup(<LibraryStatusWarning message={null} />)).toBe("");
    const host = await mount(<LibraryStatusWarning message={warning} />);
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="MCP status"]');
    if (!trigger) throw new Error("Missing warning trigger");
    expect(trigger.querySelector(".lucide-triangle-alert")).not.toBeNull();
    expect(host.textContent).not.toContain(warning);
    // Happy DOM does not implement keyboard :focus-visible matching.
    const matches = trigger.matches.bind(trigger);
    trigger.matches = (selector) => selector === ":focus-visible" ? document.activeElement === trigger : matches(selector);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      trigger.focus();
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(`MCP status${warning}`);
    expect(document.querySelector('[role="tooltip"]')?.id).toBe(trigger.getAttribute("aria-describedby"));
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("warning opens on pointer hover without performing an action", async () => {
    const host = await mount(<LibraryStatusWarning message="Calendar needs engine registration. Reload the engine to retry." />);
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="MCP status"]');
    if (!trigger) throw new Error("Missing warning trigger");
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Calendar needs engine registration");
  });
});
