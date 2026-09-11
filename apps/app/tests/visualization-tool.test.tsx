/** @jsxImportSource react */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { VisualizationTool } from "../src/components/tools/visualization-tool";
import type { AnyToolPart } from "../src/lib/tool-aggregate";

const design = {
  id: "admin-controls",
  title: "Desktop controls",
  revision: 1,
  navigation: ["Overview", "Teams", "Activity"],
  sections: [
    { title: "Summary", blocks: [{ kind: "metric", label: "Controlled members", value: "14" }] },
    { title: "Rules", nav: "Teams", columns: "two", blocks: [
      { kind: "toggle", label: "Allow uploads", value: "Off" },
      { kind: "segmented", label: "Management", items: ["Self-managed", "Controlled"], value: "Controlled" },
      { kind: "table", label: "Devices", items: ["Device | State", "MBP-1 | Active", "WIN-2 | Applying"] },
    ] },
    { title: "Recent", nav: "Activity", blocks: [{ kind: "list", label: "Log", items: ["Enabled by Ada", "<script>window.mockupExecuted = true</script>"] }] },
  ],
};

const base = { type: "dynamic-tool", toolName: "openwork_visualization", toolCallId: "call-1", input: design } as const;
const available = (output: unknown = JSON.stringify(design)): AnyToolPart => ({ ...base, state: "output-available", output });
const failed = (errorText: string): AnyToolPart => ({ ...base, state: "output-error", errorText });

let container: HTMLDivElement;
let root: Root;
let prompts: string[];

function mount(toolPart: AnyToolPart) {
  prompts = [];
  const client = createOpenworkServerClient({ baseUrl: "http://unused.invalid" });
  return act(async () => {
    root.render(
      <MessageListProvider client={client} workspaceId="w" sessionId="s" readOnly={false}
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={(text) => { prompts.push(text); }} onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}} onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("unused"); }}
        onMcpReopenAuthorization={async () => {}} onMcpRetry={() => {}}>
        <VisualizationTool part={toolPart} />
      </MessageListProvider>,
    );
  });
}

const click = (element: Element | null) =>
  act(async () => { element?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const byText = (text: string) =>
  Array.from(container.querySelectorAll<HTMLElement>("button, li, td, div, span")).find((node) => node.textContent?.trim() === text) ?? null;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(async () => {
  await act(async () => { root.unmount(); });
  await GlobalRegistrator.unregister();
});

describe("VisualizationTool", () => {
  test("navigation items become pages when sections name them", async () => {
    await mount(available());
    expect(container.textContent).toContain("Visualization · v1 · Mockup");
    expect(container.textContent).toContain("Controlled members");
    expect(container.textContent).not.toContain("Allow uploads");
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Teams", "Activity"]);

    await click(tabs[1]);
    expect(container.textContent).toContain("Controlled members");
    expect(container.textContent).toContain("Allow uploads");
    expect(container.textContent).not.toContain("Enabled by Ada");
    expect(container.querySelectorAll("th").length).toBe(2);
    expect(container.querySelectorAll("td").length).toBe(4);

    await click(tabs[2]);
    expect(container.textContent).toContain("Enabled by Ada");
    expect(container.querySelectorAll("script").length).toBe(0);
    expect(Reflect.get(globalThis, "mockupExecuted")).toBeUndefined();
  });

  test("mock controls respond locally without sending anything", async () => {
    await mount(available());
    await click(container.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    await click(radios[0]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    const collapse = byText("Rules")?.closest("button") ?? null;
    await click(collapse);
    expect(container.textContent).not.toContain("Allow uploads");
    expect(prompts).toEqual([]);

    await click(byText("Request changes"));
    expect(prompts).toEqual([
      'Revise visualization "Desktop controls" (id: admin-controls, version 1). Create version 2 with these changes: ',
    ]);
  });

  test("a rejected design explains what to fix and offers a retry", async () => {
    await mount(failed(
      "Visualization rejected. Fix these and call openwork_visualization again with the complete design:\n- sections: Too big: expected array to have <=12 items\n- sections.0.blocks.3.kind: Invalid option\nLimits: …",
    ));
    expect(container.textContent).toContain("Couldn’t create this visualization.");
    expect(container.textContent).toContain("sections: Too big");
    expect(container.textContent).toContain("blocks.3.kind: Invalid option");
    await click(byText("Try again"));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Try the visualization again");
  });

  test("older stored output without navigation pages still renders every section", async () => {
    const legacy = { ...design, navigation: ["Home"], sections: design.sections.map(({ nav: _nav, ...section }) => section) };
    await mount(available(JSON.stringify(legacy)));
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(container.textContent).toContain("Home");
    expect(container.textContent).toContain("Allow uploads");
    expect(container.textContent).toContain("Enabled by Ada");
  });
});
