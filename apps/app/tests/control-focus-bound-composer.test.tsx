/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import {
  OpenworkControlProvider,
  useControlAction,
  type OpenworkControlAPI,
  type OpenworkControlAction,
} from "../src/react-app/shell/control/control-provider";

/**
 * Why acting on another session used to move the person's pane.
 *
 * The composer registers `composer.set_text` / `composer.send` only from the
 * surface that is the control target (session-surface.tsx:
 * `useControlAction(props.isControlTarget ? … : null)`, with
 * `isControlTarget={activeWorkbenchPane === "primary" | "secondary"}` in
 * session-page.tsx). There is one registration slot per action id, so the
 * actions are bound to whichever pane is focused at execution time, not to a
 * session. An agent that wanted to message session B therefore had to make B
 * the focused pane first (session.open), which is the navigation the person
 * saw, and any focus change between set_text and send re-pointed both actions
 * at the newly focused session. This test pins that mechanics down so the
 * headless path (session.send by id, executed on the server) is the documented
 * way to reach a session.
 */

type Surface = { sessionId: string; drafts: string[]; sent: string[] };

function ComposerSurface({ surface, controlTarget }: { surface: Surface; controlTarget: boolean }) {
  const setText = useMemo<OpenworkControlAction>(() => ({
    id: "composer.set_text",
    label: "Type into the composer",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    execute: (args) => {
      const text = typeof args === "object" && args && "text" in args && typeof args.text === "string" ? args.text : "";
      surface.drafts.push(text);
      return { draftLength: text.length };
    },
  }), [surface]);
  const send = useMemo<OpenworkControlAction>(() => ({
    id: "composer.send",
    label: "Send the composer prompt",
    sideEffect: "mutation",
    execute: () => {
      surface.sent.push(surface.drafts.at(-1) ?? "");
      return true;
    },
  }), [surface]);
  useControlAction(controlTarget ? setText : null);
  useControlAction(controlTarget ? send : null);
  return null;
}

function Workbench({ a, b, focused }: { a: Surface; b: Surface; focused: "a" | "b" }) {
  return (
    <MemoryRouter>
      <OpenworkControlProvider>
        <ComposerSurface surface={a} controlTarget={focused === "a"} />
        <ComposerSurface surface={b} controlTarget={focused === "b"} />
      </OpenworkControlProvider>
    </MemoryRouter>
  );
}

const ownedDom = typeof window === "undefined";
let previousActEnvironment: unknown;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterAll(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function api(): OpenworkControlAPI {
  const current = window.__openworkControl;
  if (!current) throw new Error("control API not mounted");
  return current;
}

test("composer.* follow the focused pane: a focus change between set_text and send misroutes the draft", async () => {
  const a: Surface = { sessionId: "ses_a", drafts: [], sent: [] };
  const b: Surface = { sessionId: "ses_b", drafts: [], sent: [] };

  await act(async () => { root.render(<Workbench a={a} b={b} focused="a" />); });

  // Both composer actions are registered exactly once and carry no session id.
  const descriptors = api().context().availableAffordances.filter((entry) => entry.id.startsWith("composer."));
  expect(descriptors.map((entry) => entry.id).sort()).toEqual(["composer.send", "composer.set_text"]);
  expect(descriptors.every((entry) => entry.arguments.every((argument) => argument.name !== "sessionId"))).toBe(true);

  // The agent "types" for session A while A is focused …
  let typed: unknown;
  await act(async () => {
    typed = await api().command({ id: "composer.set_text", args: { text: "Report for A" } });
  });
  expect(typed).toMatchObject({ ok: true, effects: { ui: "focus" } });
  expect(a.drafts).toEqual(["Report for A"]);
  expect(b.drafts).toEqual([]);

  // … the person clicks pane B before the agent's next call lands …
  await act(async () => { root.render(<Workbench a={a} b={b} focused="b" />); });

  // … and composer.send now resolves to B's handler: the draft meant for A is
  // sent from B. This is the misroute observed in the audit session.
  let sent: unknown;
  await act(async () => {
    sent = await api().command({ id: "composer.send" });
  });
  expect(sent).toMatchObject({ ok: true });
  expect(a.sent).toEqual([]);
  expect(b.sent).toEqual([""]);
});

test("effects.ui is descriptive metadata: nothing in dispatch reads it, so only the action body decides what moves", async () => {
  const a: Surface = { sessionId: "ses_a", drafts: [], sent: [] };
  const b: Surface = { sessionId: "ses_b", drafts: [], sent: [] };
  await act(async () => { root.render(<Workbench a={a} b={b} focused="a" />); });

  // A command that claims ui:none and one that claims ui:navigate run through
  // the same path and are reported back verbatim; there is no gate to honour.
  const noneResult = await act(async () => api().command({ id: "composer.send" }));
  expect(noneResult).toMatchObject({ ok: true, effects: { data: "write", ui: "none", external: false } });
  const focusResult = await act(async () => api().command({ id: "composer.set_text", args: { text: "x" } }));
  expect(focusResult).toMatchObject({ ok: true, effects: { data: "none", ui: "focus", external: false } });
});
