import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { DenSelect } from "../../../_components/ui/select";
import { SavedUndoLine } from "../../_components/scoped-setting";
import { REMOTE_ACCESS_OPTIONS, RemoteAccessSettingView, remoteAccessChoices, remoteAccessMeaning, remoteAccessSettingUnavailable, remoteAccessUndoable } from "./remote-access-setting";
import { RemoteAccessSettingsError } from "./remote-access-data";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

type ViewProps = Parameters<typeof RemoteAccessSettingView>[0];
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

test("the setting is one row under Remote access: its label, a select with the choices, and what the current one means", () => {
  const html = renderToStaticMarkup(<RemoteAccessSettingView {...view()} />);
  const page = text(html);
  assert.match(page, /Remote access What other devices can do on computers Start tasks on a computer Members' other devices, Workbot and agents working for them can start tasks on a computer and follow the ones they started\./);
  assert.match(html, /data-testid="session-access-setting"/);
  // The select shows the current choice; the others are in its menu, not on the page.
  assert.match(html, /<button[^>]*data-testid="session-access-select"[^>]*aria-labelledby="session-access-label"|<button[^>]*aria-labelledby="session-access-label"[^>]*data-testid="session-access-select"/);
  assert.doesNotMatch(page, /open sessions|Off |Nobody/);
  assert.doesNotMatch(html, /type="radio"|<select|disabled=""|session-access-locked|Saved\./);
  // Narrowest first.
  assert.deepEqual(REMOTE_ACCESS_OPTIONS.map((entry) => entry.value), ["off", "created", "all"]);
  assert.deepEqual(select(RemoteAccessSettingView(view())).options, [
    { value: "off", label: "Off", testId: "session-access-off" },
    { value: "created", label: "Start tasks on a computer", testId: "session-access-created" },
    { value: "all", label: "Start tasks and open sessions, if the member turns it on", testId: "session-access-all" },
  ]);

  const wide = text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "all" })} />));
  assert.match(wide, /What other devices can do on computers Start tasks and open sessions, if the member turns it on A member can also let their other devices reach sessions started on their own computer\. Each member chooses per computer, and it never gives anyone access to another member's sessions\./);
  assert.doesNotMatch(wide, /Start tasks on a computer/);
});

test("Off says that nobody's computer takes anything from other devices", () => {
  const html = renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "off" })} />);
  assert.match(text(html), /What other devices can do on computers Off Nobody's computer takes tasks or shares sessions with other devices\./);
  assert.match(html, /data-testid="session-access-meaning"[^>]*>Nobody(&#x27;|')s computer takes tasks or shares sessions with other devices\.</);
  assert.equal(select(RemoteAccessSettingView(view({ access: "off" }))).value, "off");
  assert.equal(remoteAccessMeaning("off", false), "Nobody's computer takes tasks or shares sessions with other devices.");
  // The opt-in changes nothing about what Off means.
  assert.equal(remoteAccessMeaning("off", true), remoteAccessMeaning("off", false));
});

test("Start tasks and open sessions is offered only while the organization can choose it, or while it is the value in force", () => {
  const values = (overrides: Partial<ViewProps>) => select(RemoteAccessSettingView(view(overrides))).options.map((option) => option.value);
  const modes: RemoteSessionAccessMode[] = ["off", "created", "all"];
  for (const access of modes) {
    assert.deepEqual(values({ access, allowsAll: true }), ["off", "created", "all"], `${access}, allowed`);
    assert.deepEqual(remoteAccessChoices(access, true), ["off", "created", "all"]);
  }
  assert.deepEqual(values({ access: "off", allowsAll: false }), ["off", "created"]);
  assert.deepEqual(values({ access: "created", allowsAll: false }), ["off", "created"]);
  // Still the value in force: the select shows it, and it can only be narrowed from there.
  assert.deepEqual(values({ access: "all", allowsAll: false }), ["off", "created", "all"]);
  assert.match(text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "all", allowsAll: false })} />)), /Start tasks and open sessions, if the member turns it on/);
  // An older API does not say: there it could always be chosen.
  assert.deepEqual(values({ access: "created" }), ["off", "created", "all"]);

  // A value the select does not offer is never saved, even if something asks for it.
  const chosen: RemoteSessionAccessMode[] = [];
  const tree = RemoteAccessSettingView(view({ access: "created", allowsAll: false, onChange: (access) => { chosen.push(access); } }));
  select(tree).choose("all");
  assert.deepEqual(chosen, []);
  select(tree).choose("off");
  assert.deepEqual(chosen, ["off"]);
});

test("with the opt-in, Start tasks on a computer adds that each member allows their own computers", () => {
  const optIn = text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ optIn: true })} />));
  assert.match(optIn, /Start tasks on a computer Members' other devices, Workbot and agents working for them can start tasks on a computer and follow the ones they started\. Each member allows their computers themselves; until they do, nothing reaches them\./);
  assert.equal(remoteAccessMeaning("created", true), "Members' other devices, Workbot and agents working for them can start tasks on a computer and follow the ones they started. Each member allows their computers themselves; until they do, nothing reaches them.");
  assert.equal(remoteAccessMeaning("created", false), "Members' other devices, Workbot and agents working for them can start tasks on a computer and follow the ones they started.");
  // The other two read as they do without it.
  assert.equal(remoteAccessMeaning("all", true), remoteAccessMeaning("all", false));
  assert.doesNotMatch(text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "all", optIn: true })} />)), /until they do/);
  assert.doesNotMatch(text(renderToStaticMarkup(<RemoteAccessSettingView {...view()} />)), /until they do/);
});

test("choosing another option saves it; choosing the current one does nothing", () => {
  const chosen: RemoteSessionAccessMode[] = [];
  const tree = RemoteAccessSettingView(view({ onChange: (access) => { chosen.push(access); } }));
  assert.equal(select(tree).value, "created");
  select(tree).choose("created");
  select(tree).choose("nonsense");
  assert.deepEqual(chosen, []);
  select(tree).choose("all");
  select(tree).choose("off");
  assert.deepEqual(chosen, ["all", "off"]);
});

test("a save shows what is now true with Undo, and a failed one says why", () => {
  const widened = renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "all", saved: "all" })} />);
  assert.match(text(widened), /Saved\. Members can now let other devices open sessions on their own computers\. Undo/);
  const narrowed = text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ saved: "created" })} />));
  assert.match(narrowed, /Saved\. Other devices can start tasks on a computer, and nothing more\. Undo/);
  const off = text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "off", saved: "off" })} />));
  assert.match(off, /Saved\. Other devices can no longer reach any computer in this organization\. Undo/);
  const failed = renderToStaticMarkup(<RemoteAccessSettingView {...view({ saved: "all", error: "Couldn't save this setting. Try again." })} />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(text(failed), /Saved\./);
  // While a save is in flight the select waits for it.
  assert.ok(select(RemoteAccessSettingView(view({ saving: true }))).disabled);
  assert.match(renderToStaticMarkup(<RemoteAccessSettingView {...view({ saving: true })} />), /<button[^>]*data-testid="session-access-select"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="session-access-select"/);
});

test("a save that cannot be taken back shows what is now true, without an Undo that would be refused", () => {
  // "Start tasks and open sessions" was in force in an organization that may no longer choose it; an admin narrowed it.
  assert.equal(remoteAccessUndoable("all", false), false);
  const narrowed = renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "created", allowsAll: false, saved: "created", undoable: false })} />);
  assert.match(text(narrowed), /Saved\. Other devices can start tasks on a computer, and nothing more\./);
  assert.match(narrowed, /role="status"/);
  assert.doesNotMatch(narrowed, /Undo/);
  const off = renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "off", allowsAll: false, saved: "off", undoable: false })} />);
  assert.match(text(off), /Saved\. Other devices can no longer reach any computer in this organization\./);
  assert.doesNotMatch(off, /Undo/);
  // And "Start tasks and open sessions" is no longer among the choices either.
  assert.deepEqual(select(RemoteAccessSettingView(view({ access: "created", allowsAll: false, saved: "created", undoable: false }))).options.map((option) => option.value), ["off", "created"]);

  // Every other way back can be chosen again, so it keeps its Undo.
  assert.equal(remoteAccessUndoable("all", true), true);
  for (const allowsAll of [false, true]) {
    assert.equal(remoteAccessUndoable("off", allowsAll), true);
    assert.equal(remoteAccessUndoable("created", allowsAll), true);
  }
  assert.match(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "off", allowsAll: false, saved: "off" })} />), /Undo/);
  let undone = 0;
  const tree = RemoteAccessSettingView(view({ access: "created", saved: "created", onUndo: () => { undone += 1; } }));
  const line = elements(tree).find((element) => element.type === SavedUndoLine);
  assert.ok(line, "No saved line");
  (line.props.onUndo as () => void)();
  assert.equal(undone, 1);
  const stuck = elements(RemoteAccessSettingView(view({ access: "created", saved: "created", undoable: false, onUndo: () => { undone += 1; } }))).find((element) => element.type === SavedUndoLine);
  assert.ok(stuck);
  assert.equal(stuck.props.onUndo, undefined);
});

test("someone who cannot edit sees the current choice, disabled, with who can change it", () => {
  for (const access of ["off", "created", "all"] as const) {
    const html = renderToStaticMarkup(<RemoteAccessSettingView {...view({ access, canEdit: false })} />);
    // Den lets whoever may edit organization settings change it: owners and admins unless roles say otherwise.
    assert.match(text(html), /Needs the “Edit organization settings” permission\. Ask (the organization owner|an organization owner or admin for access)\./);
    assert.match(html, /data-testid="session-access-locked"/);
    assert.ok(select(RemoteAccessSettingView(view({ access, canEdit: false }))).disabled);
  }
  assert.match(text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "all", canEdit: false })} />)), /Start tasks and open sessions, if the member turns it on/);
  assert.match(text(renderToStaticMarkup(<RemoteAccessSettingView {...view({ access: "off", canEdit: false })} />)), /Off Nobody's computer takes tasks/);
});

test("the row is there whenever Den serves the setting, and gone only when an older API answers 404", () => {
  assert.ok(remoteAccessSettingUnavailable(new RemoteAccessSettingsError("not_found", "Not found.", 404)));
  assert.ok(remoteAccessSettingUnavailable(new RemoteAccessSettingsError("feature_disabled", "This feature is not enabled.", 404)));
  // Any other failure keeps the row, with the reason and a way to retry.
  assert.ok(!remoteAccessSettingUnavailable(new RemoteAccessSettingsError("forbidden", "No.", 403)));
  assert.ok(!remoteAccessSettingUnavailable(new RemoteAccessSettingsError("http_500", "Couldn't load this setting. Try again.", 500)));
  assert.ok(!remoteAccessSettingUnavailable(new RemoteAccessSettingsError("network_error", "Couldn't reach OpenWork.")));
  assert.ok(!remoteAccessSettingUnavailable(new Error("boom")));
  assert.ok(!remoteAccessSettingUnavailable(null));
});
