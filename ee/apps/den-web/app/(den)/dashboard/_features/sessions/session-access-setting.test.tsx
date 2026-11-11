import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { DenSelect } from "../../../_components/ui/select";
import { mapFeatures } from "@openwork/features";
import { OrgSessionAccessSetting, SESSION_ACCESS_OPTIONS, SessionAccessSetting, SessionAccessSettingView } from "./session-access-setting";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

type ViewProps = Parameters<typeof SessionAccessSettingView>[0];
const view = (overrides: Partial<ViewProps> = {}): ViewProps => ({
  access: "created", canEdit: true, saving: false, saved: null, error: null, onChange: () => {}, onUndo: () => {}, ...overrides,
});

type AnyElement = ReactElement<Record<string, unknown>>;
/** Every element a hook-free component renders, with the plain components inside it rendered too. */
function elements(node: ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as AnyElement;
  const own = [element, ...elements(element.props.children as ReactNode)];
  if (typeof element.type !== "function" || element.type === DenSelect) return own;
  try {
    return [...own, ...elements((element.type as (props: unknown) => ReactNode)(element.props))];
  } catch {
    return own;
  }
}
/** The one select of the row: what it offers, and a way to pick an option as a person would. */
function select(tree: ReactNode): { disabled: boolean; value: unknown; options: Array<{ value: unknown; label: unknown; testId: unknown }>; choose: (value: string) => void } {
  const found = elements(tree).find((element) => element.type === DenSelect);
  assert.ok(found, "No select");
  const options = elements(found.props.children as ReactNode).filter((element) => element.type === "option");
  return {
    disabled: found.props.disabled === true,
    value: found.props.value,
    options: options.map((option) => ({ value: option.props.value, label: option.props.children, testId: option.props["data-testid"] })),
    choose: (value) => (found.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }),
  };
}

test("the setting is one row under Remote access: its label, a select with the two choices, and what the current one means", () => {
  const html = renderToStaticMarkup(<SessionAccessSettingView {...view()} />);
  const page = text(html);
  assert.match(page, /Remote access Sessions other devices can reach Only sessions started remotely Members can follow and answer tasks they started from another device\./);
  assert.match(html, /data-testid="session-access-setting"/);
  // The select shows the current choice; the other one is in its menu, not on the page.
  assert.match(html, /<button[^>]*data-testid="session-access-select"[^>]*aria-labelledby="session-access-label"|<button[^>]*aria-labelledby="session-access-label"[^>]*data-testid="session-access-select"/);
  assert.doesNotMatch(page, /All sessions/);
  assert.doesNotMatch(html, /type="radio"|<select|disabled=""|session-access-locked|Saved\./);
  assert.deepEqual(SESSION_ACCESS_OPTIONS.map((entry) => entry.value), ["created", "all"]);
  assert.deepEqual(select(SessionAccessSettingView(view())).options, [
    { value: "created", label: "Only sessions started remotely", testId: "session-access-created" },
    { value: "all", label: "All sessions, if the member turns it on", testId: "session-access-all" },
  ]);

  const wide = text(renderToStaticMarkup(<SessionAccessSettingView {...view({ access: "all" })} />));
  assert.match(wide, /Sessions other devices can reach All sessions, if the member turns it on A member can also let their other devices reach sessions started on their own computer\. Each member chooses per computer, and it never gives anyone access to another member's sessions\./);
  assert.doesNotMatch(wide, /Only sessions started remotely/);
});

test("choosing the other option saves it; choosing the current one does nothing", () => {
  const chosen: RemoteSessionAccessMode[] = [];
  const tree = SessionAccessSettingView(view({ onChange: (access) => { chosen.push(access); } }));
  assert.equal(select(tree).value, "created");
  select(tree).choose("created");
  select(tree).choose("nonsense");
  assert.deepEqual(chosen, []);
  select(tree).choose("all");
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
  // While a save is in flight the select waits for it.
  assert.ok(select(SessionAccessSettingView(view({ saving: true }))).disabled);
  assert.match(renderToStaticMarkup(<SessionAccessSettingView {...view({ saving: true })} />), /<button[^>]*data-testid="session-access-select"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="session-access-select"/);
});

test("someone who cannot edit sees the current choice, disabled, with who can change it", () => {
  const html = renderToStaticMarkup(<SessionAccessSettingView {...view({ access: "all", canEdit: false })} />);
  // Den lets whoever may edit organization settings change it: owners and admins unless roles say otherwise.
  assert.match(text(html), /Needs the “Edit organization settings” permission\. Ask (the organization owner|an organization owner or admin for access)\./);
  assert.match(html, /data-testid="session-access-locked"/);
  assert.match(text(html), /All sessions, if the member turns it on/);
  assert.ok(select(SessionAccessSettingView(view({ canEdit: false }))).disabled);
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
