/** @jsxImportSource react */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  getSessionAgentSelection,
  readSessionAgentSelections,
  useSessionAgentSelection,
  useSessionAgentStore,
} from "../src/react-app/domains/session/surface/session-mode-memory";

const storageKey = "openwork.sessionAgents.v1";
const registeredDom = typeof window === "undefined";

beforeAll(() => {
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterAll(async () => {
  if (registeredDom) await GlobalRegistrator.unregister();
});

beforeEach(() => {
  window.localStorage.removeItem(storageKey);
  useSessionAgentStore.setState({ bySessionId: {} });
});

describe("session mode memory", () => {
  test("remembers independent choices and explicit Default across reload", () => {
    const { setAgent } = useSessionAgentStore.getState();
    setAgent("session-a", "plan");
    setAgent("session-b", "build");
    setAgent("session-a", null);

    const stored = readSessionAgentSelections();
    useSessionAgentStore.setState({ bySessionId: {} });
    useSessionAgentStore.setState({ bySessionId: stored });

    expect(getSessionAgentSelection("session-a", "plan")).toBeNull();
    expect(getSessionAgentSelection("session-b", "plan")).toBe("build");
    expect(getSessionAgentSelection("unknown", "plan")).toBe("plan");
    expect(stored).toEqual({ "session-b": "build", "session-a": null });
  });

  test("ignores malformed storage and invalid entries without losing valid choices", () => {
    for (const raw of ["{", "null", "[]", "1", '"plan"']) {
      window.localStorage.setItem(storageKey, raw);
      expect(readSessionAgentSelections()).toEqual({});
    }
    window.localStorage.setItem(storageKey, JSON.stringify({
      valid: "plan", custom: "review", default: null, "": "build",
      object: { agent: "build" }, array: ["build"], number: 1, blank: " ", boolean: true,
    }));
    expect(readSessionAgentSelections()).toEqual({ valid: "plan", custom: "review", default: null });
    window.localStorage.removeItem(storageKey);
    expect(readSessionAgentSelections()).toEqual({});
  });

  test("keeps memory usable when storage reads, writes, or access fail", () => {
    const read = spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    try {
      expect(readSessionAgentSelections()).toEqual({});
    } finally {
      read.mockRestore();
    }

    const write = spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("full"); });
    try {
      useSessionAgentStore.getState().setAgent("session-a", "plan");
      expect(getSessionAgentSelection("session-a")).toBe("plan");
    } finally {
      write.mockRestore();
    }

    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    try {
      Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("denied"); } });
      expect(readSessionAgentSelections()).toEqual({});
      useSessionAgentStore.getState().setAgent("session-a", null);
      expect(getSessionAgentSelection("session-a", "plan")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else Reflect.deleteProperty(window, "localStorage");
    }
  });

  test("works without a browser window", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    if (!descriptor) throw new Error("Expected a window descriptor");
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
      expect(readSessionAgentSelections()).toEqual({});
      useSessionAgentStore.getState().setAgent("session-a", "plan");
      expect(getSessionAgentSelection("session-a")).toBe("plan");
    } finally {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  });

  test("caps loaded and updated memory at 200 sessions and skips unchanged selections", () => {
    const entries = Array.from({ length: 201 }, (_, index) => [`session-${index}`, "build"]);
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
    const stored = readSessionAgentSelections();
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored["session-0"]).toBeUndefined();
    useSessionAgentStore.setState({ bySessionId: stored });

    const before = useSessionAgentStore.getState();
    before.setAgent("session-1", "build");
    expect(useSessionAgentStore.getState()).toBe(before);
    before.setAgent("session-1", "plan");
    before.setAgent("session-201", null);

    const after = readSessionAgentSelections();
    expect(Object.keys(after)).toHaveLength(200);
    expect(after["session-1"]).toBe("plan");
    expect(after["session-2"]).toBeUndefined();
    expect(after["session-201"]).toBeNull();
  });

  test("hooks isolate panes, retain selection callbacks, and keep the new-task preference separate", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const controls = new Map<string, ReturnType<typeof useSessionAgentSelection>>();
    const changeDefault = mock((_agent: string | null) => {});
    let fallbackAgent: string | null = "build";
    function Pane({ name, sessionId }: { name: string; sessionId: string | null }) {
      const selection = useSessionAgentSelection({ sessionId, fallbackAgent, onFallbackAgentChange: changeDefault });
      controls.set(name, selection);
      return <output data-pane={name}>{selection.selectedAgent ?? "default"}</output>;
    }
    const render = async (leftSession = "session-a") => {
      await act(async () => root.render(<>
        <Pane name="left" sessionId={leftSession} />
        <Pane name="right" sessionId="session-b" />
        <Pane name="new" sessionId={null} />
      </>));
    };
    const choice = (name: string) => {
      const selection = controls.get(name);
      if (!selection) throw new Error(`Missing ${name} controls`);
      return selection;
    };

    try {
      await render();
      const selectA = choice("left").setAgent;
      await act(async () => {
        selectA("plan");
        choice("right").setAgent(null);
      });
      expect(choice("left").selectedAgent).toBe("plan");
      expect(choice("right").selectedAgent).toBeNull();
      expect(choice("new").selectedAgent).toBe("build");
      expect(changeDefault).not.toHaveBeenCalled();

      await render("session-b");
      await act(async () => selectA("build"));
      expect(choice("left").selectedAgent).toBeNull();
      expect(getSessionAgentSelection("session-a")).toBe("build");
      await act(async () => choice("new").setAgent("plan"));
      expect(changeDefault).toHaveBeenCalledWith("plan");
      fallbackAgent = "plan";
      await render();
      expect(choice("left").selectedAgent).toBe("build");
      expect(choice("right").selectedAgent).toBeNull();
      expect(choice("new").selectedAgent).toBe("plan");

      // A newly seeded session must not re-adopt a newer global preference on mount.
      useSessionAgentStore.getState().setAgent("session-new", fallbackAgent);
      fallbackAgent = "build";
      await render("session-new");
      expect(choice("left").selectedAgent).toBe("plan");
      expect(choice("right").selectedAgent).toBeNull();

      const stored = readSessionAgentSelections();
      await act(async () => root.render(null));
      useSessionAgentStore.setState({ bySessionId: stored });
      await render("session-new");
      expect(choice("left").selectedAgent).toBe("plan");
      expect(choice("right").selectedAgent).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
