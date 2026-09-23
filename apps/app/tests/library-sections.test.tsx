import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { readExtensionLayout, writeExtensionLayout } from "../src/react-app/domains/settings/extension-state";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI detects DOM support at import time, including for portals and focus.
const { createRoot } = await import("react-dom/client");
const { filterForSection } = await import("../src/react-app/domains/settings/pages/extensions-view");
const { ExtensionCard } = await import("../src/react-app/design-system/extension-card");
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import("../src/components/ui/tooltip");
const { LibraryAddControl, libraryAddKindLabel } = await import("../src/react-app/domains/settings/pages/library-add-control");
const {
  connectionPluginName,
  connectMcpInventoryGroup,
  LibraryEmptyState,
  LibraryInventory,
  libraryRowAttention,
  LibraryStatusWarning,
  libraryStatusTone,
  localServerInventoryGroup,
  McpAdvancedConfigSection,
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

// Bun evaluates every test file in one shared module registry. When another
// file imports Base UI before any DOM exists, its layout effects stay no-ops for
// the rest of the run and no tooltip can open, even a controlled one. Probe that
// once so the tooltip assertions skip loudly instead of failing on file order;
// the focused Library command still runs them.
async function tooltipLayerCanOpen() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger render={<button type="button">Probe</button>} />
        <TooltipContent role="tooltip">tooltip-probe</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  ));
  const opened = document.querySelector('[role="tooltip"]')?.textContent === "tooltip-probe";
  await act(async () => root.unmount());
  host.remove();
  return opened;
}
const tooltipLayerInert = !(await tooltipLayerCanOpen());
const { Dialog, DialogContent, DialogTitle } = await import("../src/components/ui/dialog");
async function dialogLayerCanOpen() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <Dialog open>
      <DialogContent><DialogTitle>dialog-probe</DialogTitle></DialogContent>
    </Dialog>,
  ));
  const opened = document.body.textContent?.includes("dialog-probe") === true;
  await act(async () => root.unmount());
  host.remove();
  return opened;
}
const dialogLayerInert = !(await dialogLayerCanOpen());

type Row = { key: string; section: "mac" | "mine" | "openwork"; taxonomy: "skill" | "plugin" | "connection" | "mcp"; name: string };

function rowsFor(rows: Row[]) {
  return rows.map((row) => ({
    key: row.key,
    section: row.section,
    taxonomy: row.taxonomy,
    searchText: row.name,
    node: <ExtensionCard layout="list" name={row.name} description={`${row.name} description`} taxonomy={row.taxonomy} />,
  }));
}

const libraryRows: Row[] = [
  { key: "a", section: "openwork", taxonomy: "connection", name: "Google Workspace" },
  { key: "b", section: "mac", taxonomy: "skill", name: "Weekly status report" },
  { key: "c", section: "mine", taxonomy: "skill", name: "Customer briefing" },
  { key: "d", section: "mine", taxonomy: "plugin", name: "Sales call prep" },
  { key: "e", section: "mac", taxonomy: "mcp", name: "Filesystem" },
];

describe("Library sections", () => {
  test("one list: On this Mac, Added by you, then From OpenWork, each with its own caption", async () => {
    const host = await mount(
      <LibraryInventory
        rows={rowsFor(libraryRows)}
        loading={false}
        layout="list"
        filter="all"
        sectionMeta={{ mine: "2 · only you so far", openwork: "1 shared with you" }}
      />,
    );
    const sections = [...host.querySelectorAll<HTMLElement>("[data-library-section]")];
    expect(sections.map((section) => section.dataset.librarySection)).toEqual(["mac", "mine", "openwork"]);
    expect(sections[0]?.textContent).toContain("On this Mac");
    expect(sections[0]?.textContent).toContain("Weekly status report");
    expect(sections[0]?.textContent).toContain("Filesystem");
    expect(sections[1]?.textContent).toContain("Added by you");
    expect(sections[1]?.querySelector("[data-library-section-meta]")?.textContent).toBe("2 · only you so far");
    expect(sections[2]?.textContent).toContain("From OpenWork");
    expect(sections[2]?.textContent).toContain("1 shared with you");
    expect(host.textContent).not.toContain("Ready to use");
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });

  test("Skills and Plugins narrow the same list by kind; search narrows by name", async () => {
    const skills = await mount(<LibraryInventory rows={rowsFor(libraryRows)} loading={false} layout="list" filter="skill" />);
    expect([...skills.querySelectorAll("[data-library-row]")].map((row) => row.getAttribute("data-library-row"))).toEqual([
      "Weekly status report",
      "Customer briefing",
    ]);
    const plugins = await mount(<LibraryInventory rows={rowsFor(libraryRows)} loading={false} layout="list" filter="plugin" />);
    expect(plugins.textContent).toContain("Sales call prep");
    expect(plugins.textContent).not.toContain("Customer briefing");
    const searched = await mount(
      <LibraryInventory rows={rowsFor(libraryRows)} loading={false} layout="list" filter="all" search="nothing like it" emptyState={<p>empty-state</p>} />,
    );
    expect(searched.textContent).toBe("empty-state");
  });

  test("signed out: a sign-up banner and OpenWork connectors shown locked", async () => {
    const signUp = mock(() => {});
    const host = await mount(
      <LibraryInventory rows={rowsFor(libraryRows.filter((row) => row.section === "mac"))} loading={false} layout="list" filter="all" signedOut onSignUp={signUp} />,
    );
    expect(host.querySelector('[data-testid="library-sign-up-banner"]')?.textContent).toContain("Sign up to share your skills and connectors with your team.");
    const locked = host.querySelector<HTMLElement>('[data-library-section="locked"]');
    expect(locked?.textContent).toContain("From OpenWork · Sign in to use");
    expect(locked?.querySelectorAll("[data-library-locked]").length).toBeGreaterThan(0);
    expect(locked?.querySelector("button[data-library-row]")?.hasAttribute("disabled")).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="library-sign-up-banner"] button')?.click());
    expect(signUp).toHaveBeenCalledTimes(1);
  });

  test("a row that needs you says so with a chip and a button, next to its menu", async () => {
    expect(libraryRowAttention("ready")).toEqual({});
    expect(libraryRowAttention("needs_signin").statusChip?.label).toBe("Sign in");
    expect(libraryRowAttention("needs_admin_setup").actionLabel).toBe("Set up");
    const next = mock(() => {});
    const host = await mount(
      <ExtensionCard
        layout="list"
        name="Slack"
        description="Messages and channels"
        taxonomy="connection"
        statusChip={{ label: "Sign in", tone: "attention" }}
        nextActionLabel="Sign in"
        onNextAction={next}
        trailing={<button type="button">menu</button>}
      />,
    );
    expect(host.querySelector("[data-library-status]")?.textContent).toBe("Sign in");
    expect(host.textContent).toContain("Connector");
    expect(host.textContent).toContain("menu");
    const action = [...host.querySelectorAll("span")].find((span) => span.textContent === "Sign in" && !span.hasAttribute("data-library-status"));
    await act(async () => action?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("a connector's row finds the connection Den made for it, named plugin / server", () => {
    expect(connectionPluginName("Slack / slack")).toBe("slack");
    expect(connectionPluginName("Team wiki")).toBe("team wiki");
    expect(connectionPluginName("Docs / Search / docs")).toBe("docs / search");
  });

  test("legacy routes land on All, and the list is the initial layout", () => {
    expect(filterForSection(undefined)).toBe("mcp");
    expect(readExtensionLayout()).toBe("list");
    writeExtensionLayout("grid");
    expect(readExtensionLayout()).toBe("grid");
    window.localStorage.setItem("openwork.extensions.layout", "obsolete");
    expect(readExtensionLayout()).toBe("list");
  });

  test("Cloud MCP and workspace server status never label setup failures as sign-in", () => {
    const entry = { name: "Calendar", config: { type: "remote", url: "https://calendar.example/mcp" } } as const;
    expect(connectMcpInventoryGroup(entry, { Calendar: { status: "needs_auth" } })).toBe("needs_signin");
    expect(connectMcpInventoryGroup(entry, { Calendar: { status: "failed", error: "unavailable" } })).toBe("available");
    expect(connectMcpInventoryGroup(entry, { Calendar: { status: "disabled" } })).toBe("disabled");
    expect(localServerInventoryGroup("connected")).toBe("ready");
    expect(localServerInventoryGroup("needs_client_registration")).toBe("needs_signin");
    expect(localServerInventoryGroup("failed")).toBe("available");
  });

  test.each([
    ["all", "Your Library is empty", "Create skill"],
    ["skill", "No skills yet", "Create skill"],
    ["plugin", "No plugins yet", "Add plugin"],
  ] as const)("%s empty state offers the matching creation action", async (filter, title, label) => {
    const onAdd = mock(() => {});
    const host = await mount(<LibraryEmptyState filter={filter} searching={false} onAdd={onAdd} onClearSearch={() => {}} />);
    expect(host.textContent).toContain(title);
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  test("search-empty clears filters rather than offering another install", async () => {
    const onClear = mock(() => {});
    const onAdd = mock(() => {});
    const host = await mount(<LibraryEmptyState filter="skill" searching onAdd={onAdd} onClearSearch={onClear} />);
    expect(host.textContent).toContain("No library items match");
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  test("unavailable Cloud is distinct from a genuinely empty Library", async () => {
    const refresh = mock(() => {});
    const host = await mount(<LibraryEmptyState filter="all" searching={false} error="Inventory could not be loaded" onRefresh={refresh} onClearSearch={() => {}} />);
    expect(host.textContent).toContain("OpenWork Cloud is unavailable");
    expect(host.textContent).toContain("Inventory could not be loaded");
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test.skipIf(dialogLayerInert)("labeled Library Add opens the picker: Skill, Connector, Plugin", async () => {
    const select = mock(() => {});
    const host = await mount(<LibraryAddControl kinds={["skill", "connection", "plugin"]} label="Add to library" onSelect={select} />);
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Add to library"]');
    await act(async () => button?.click());
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="library-add-choices"] button[data-kind]')];
    expect(choices.map((choice) => choice.dataset.kind)).toEqual(["skill", "connection", "plugin"]);
    expect(choices.map((choice) => choice.querySelector("[data-kind-title]")?.textContent)).toEqual(["Skill", "Connector", "Plugin"]);
    await act(async () => choices[1]?.click());
    expect(select).toHaveBeenCalledWith("connection");
    expect(document.querySelector('[data-testid="library-add-choices"]')).toBeNull();
  });

  test("Library Add labels", () => {
    expect(libraryAddKindLabel("connection")).toBe("Add a connector");
    expect(libraryAddKindLabel("workspace-mcp")).toBe("Add workspace MCP");
  });

  test.each([false, true])("Library picker stays closed while unavailable (pending=%s)", async (pending) => {
    const select = mock(() => {});
    const host = await mount(<LibraryAddControl kinds={["mcp", "skill", "plugin"]} label="Add to library" pending={pending} disabledReason={pending ? undefined : "Sign in to OpenWork Cloud"} onSelect={select} />);
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Add to library"]');
    await act(async () => button?.click());
    expect(document.querySelector('[data-testid="library-add-choices"]')).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  test("Advanced keeps only workspace MCP creation and config, hidden when closed or policy denies it", () => {
    const base = { configScope: "project", activeConfig: null, canRevealConfig: false, revealBusy: false, revealLabel: "Open file", configError: null, onToggle: () => {}, onScopeChange: () => {}, onReveal: async () => {} } as const;
    const closed = renderToStaticMarkup(<McpAdvancedConfigSection {...base} open={false} onAddMcp={() => {}} />);
    expect(closed).toContain("Advanced settings");
    expect(closed).not.toContain("Add workspace MCP");
    const open = renderToStaticMarkup(<McpAdvancedConfigSection {...base} open onAddMcp={() => {}} />);
    expect(open).toContain("Add workspace MCP");
    expect(open).toContain("Open file");
    // Inventory never lives here: no cards, group headers, or plugin lists.
    expect(open).not.toContain("READY TO USE");
    expect(open).not.toContain("OpenCode Plugins");
    const restricted = renderToStaticMarkup(<McpAdvancedConfigSection {...base} open />);
    expect(restricted).not.toContain("Add workspace MCP");
  });

  test("warning is conditional and keeps its message out of the page until opened", async () => {
    const warning = "Some MCPs could not be registered with the engine: Calendar, Notes. They may appear disconnected - try reloading the engine.";
    expect(renderToStaticMarkup(<LibraryStatusWarning message={null} />)).toBe("");
    expect(renderToStaticMarkup(<LibraryStatusWarning message="   " />)).toBe("");
    // Progress and success notes are shown as information, not as an alert.
    expect(libraryStatusTone("Reloading MCP servers…")).toBe("info");
    expect(libraryStatusTone("Connected")).toBe("info");
    expect(libraryStatusTone(warning)).toBe("warning");
    expect(renderToStaticMarkup(<LibraryStatusWarning message="Connected" />)).not.toContain("bg-amber-3");
    const host = await mount(<LibraryStatusWarning message={warning} />);
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="MCP status"]');
    if (!trigger) throw new Error("Missing warning trigger");
    expect(trigger.querySelector(".lucide-triangle-alert")).not.toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    expect(host.textContent).not.toContain(warning);
    expect(document.body.textContent).not.toContain(warning);
  });

  test.skipIf(tooltipLayerInert)("warning is keyboard-focusable, preserves guidance, and Escape dismisses it", async () => {
    const warning = "Some MCPs could not be registered with the engine: Calendar, Notes. They may appear disconnected - try reloading the engine.";
    const host = await mount(<LibraryStatusWarning message={warning} />);
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="MCP status"]');
    if (!trigger) throw new Error("Missing warning trigger");
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

  test.skipIf(tooltipLayerInert)("warning opens on pointer hover without performing an action", async () => {
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
