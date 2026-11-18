/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readAgentForm, type AgentForm } from "@openwork/types/agent-form";
import { AgentFormCard } from "../src/react-app/domains/session/modals/agent-form-card";

const form: AgentForm = {
  title: "Roadmap details",
  fields: [
    { kind: "choice", question: "Which areas?", multiple: true, options: [{ label: "Mobile app", icon: "smartphone" }, { label: "Security fixes", icon: "shield-check", tone: "danger" }] },
    { kind: "scale", question: "How polished?", min: 1, max: 5, minLabel: "Rough", maxLabel: "Polished" },
    { kind: "date", question: "Wrap up by?" },
    { kind: "text", question: "Anything else?" },
  ],
};

describe("agent form card", () => {
  test("reads the form only when it matches the request's fields", () => {
    expect(readAgentForm({ kind: "question", form }, 4)?.title).toBe("Roadmap details");
    expect(readAgentForm({ kind: "question", form }, 3)).toBeUndefined();
    expect(readAgentForm({ kind: "question" }, 4)).toBeUndefined();
  });

  test("draws every field kind and replies one answer per field", async () => {
    const ownedDom = typeof window === "undefined";
    if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const replies: string[][][] = [];
    try {
      await act(async () => { root.render(<AgentFormCard form={form} busy={false} onReply={(a) => replies.push(a)} onDismiss={() => {}} />); });
      expect(container.querySelectorAll("[data-form-field]")).toHaveLength(4);
      expect(container.querySelector("input[type='range']")).not.toBeNull();
      expect(container.querySelector("input[type='date']")).not.toBeNull();
      expect(container.querySelector("textarea")).not.toBeNull();
      const card = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Security fixes"))!;
      await act(async () => { card.click(); });
      expect(card.getAttribute("aria-checked")).toBe("true");
      const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Submit")!;
      await act(async () => { submit.click(); });
      expect(replies).toEqual([[["Security fixes"], ["3"], [], []]]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      if (ownedDom) await GlobalRegistrator.unregister();
    }
  });
});
