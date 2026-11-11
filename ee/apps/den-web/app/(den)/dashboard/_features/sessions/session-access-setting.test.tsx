import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { DenOptionCard } from "../../../_components/ui/option-card";
import { mapFeatures } from "@openwork/features";
import { OrgSessionAccessSetting, SESSION_ACCESS_OPTIONS, SessionAccessSetting, SessionAccessSettingView } from "./session-access-setting";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

type ViewProps = Parameters<typeof SessionAccessSettingView>[0];
const view = (overrides: Partial<ViewProps> = {}): ViewProps => ({
  access: "created", canEdit: true, saving: false, saved: null, error: null, onChange: () => {}, onUndo: () => {}, ...overrides,
});

type AnyElement = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as AnyElement;
  return [element, ...elements(element.props.children as ReactNode)];
}
function option(tree: ReactNode, title: string): { disabled: boolean; choose: () => void } {
  const found = elements(tree).find((element) => element.type === DenOptionCard && element.props.title === title);
  assert.ok(found, `No "${title}" option`);
  return { disabled: found.props.disabled === true, choose: () => (found.props.onChange as (checked: boolean) => void)(true) };
}

test("the setting offers the two choices in plain words, with the narrow one first", () => {
  const html = renderToStaticMarkup(<SessionAccessSettingView {...view()} />);
  const page = text(html);
  assert.match(page, /Sessions other devices can reach Only sessions started remotely Members can follow and answer tasks they started from another device\. All sessions, if the member turns it on A member can also let their other devices reach sessions started on their own computer\. Each member chooses per computer, and it never gives anyone access to another member's sessions\./);
  assert.deepEqual(SESSION_ACCESS_OPTIONS.map((entry) => entry.value), ["created", "all"]);
  assert.equal(html.match(/type="radio"/g)?.length, 2);
  assert.match(html, /<input[^>]*data-testid="session-access-created"[^>]*checked=""/);
  assert.doesNotMatch(html, /<input[^>]*data-testid="session-access-all"[^>]*checked=""/);
  assert.doesNotMatch(html, /disabled=""|session-access-locked|Saved\./);
  const wide = renderToStaticMarkup(<SessionAccessSettingView {...view({ access: "all" })} />);
  assert.match(wide, /<input[^>]*data-testid="session-access-all"[^>]*checked=""/);
});

test("choosing the other option saves it; choosing the current one does nothing", () => {
  const chosen: RemoteSessionAccessMode[] = [];
  const tree = SessionAccessSettingView(view({ onChange: (access) => { chosen.push(access); } }));
  option(tree, "Only sessions started remotely").choose();
  assert.deepEqual(chosen, []);
  option(tree, "All sessions, if the member turns it on").choose();
  assert.deepEqual(chosen, ["all"]);
});

test("a save shows what is now true with Undo, and a failed one says why", () => {
  const widened = renderToStaticMarkup(<SessionAccessSettingView {...view({ access: "all", saved: "all" })} />);
  assert.match(text(widened), /Saved\. Members can now choose all sessions for their own computers\. Undo/);
  const narrowed = text(renderToStaticMarkup(<SessionAccessSettingView {...view({ saved: "created" })} />));
  assert.match(narrowed, /Saved\. Other devices reach only sessions started remotely\. Undo/);
  const failed = renderToStaticMarkup(<SessionAccessSettingView {...view({ saved: "all", error: "Couldn't save this setting. Try again." })} />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(text(failed), /Saved\./);
  // While a save is in flight the choices wait for it.
  assert.equal(renderToStaticMarkup(<SessionAccessSettingView {...view({ saving: true })} />).match(/<input[^>]*disabled=""/g)?.length, 2);
});

test("someone who cannot edit sees the current choice, disabled, with who can change it", () => {
  const html = renderToStaticMarkup(<SessionAccessSettingView {...view({ access: "all", canEdit: false })} />);
  // Den lets whoever may edit organization settings change it: owners and admins unless roles say otherwise.
  assert.match(text(html), /Needs the “Edit organization settings” permission\. Ask (the organization owner|an organization owner or admin for access)\./);
  assert.match(html, /data-testid="session-access-locked"/);
  assert.equal(html.match(/<input[^>]*disabled=""/g)?.length, 2);
  assert.match(html, /<input[^>]*data-testid="session-access-all"[^>]*checked=""/);
  assert.ok(option(SessionAccessSettingView(view({ canEdit: false })), "All sessions, if the member turns it on").disabled);
});

test("the setting is on Computers only while the organization has remoteSessionAccess on", () => {
  const off = { features: mapFeatures(() => false) };
  const on = { features: mapFeatures((key) => key === "remoteSessionAccess") };
  // Other features, even Computers itself, do not bring it along.
  const others = { features: mapFeatures((key) => key !== "remoteSessionAccess") };
  for (const orgContext of [off, others, null, undefined]) {
    assert.equal(OrgSessionAccessSetting({ orgId: "org_1", orgContext }), null);
    assert.equal(renderToStaticMarkup(<OrgSessionAccessSetting orgId="org_1" orgContext={orgContext} />), "");
  }
  const shown = OrgSessionAccessSetting({ orgId: "org_1", orgContext: on });
  assert.ok(isValidElement(shown));
  assert.equal(shown.type, SessionAccessSetting);
  assert.deepEqual(shown.props, { orgId: "org_1" });
});
