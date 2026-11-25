import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import { AccessRow, AddPicker, RemoveButton, accessAddButtonClassName } from "./access-rows";
import { WhoCanUseIt } from "./who-can-use-it";

const person: DenOrgMember = {
  id: "member-reader", userId: "user-reader", inviteId: null,
  role: "member", effectiveRole: "member", adminTeams: [], createdAt: null,
  joinedAt: "2026-01-01", isOwner: false, openworkWeb: false,
  user: { id: "user-reader", name: "Alex Example", email: "alex@example.test", image: null },
};
const team: DenOrgTeam = {
  id: "team-design", name: "Design", memberIds: [person.id], createdAt: null,
  updatedAt: null, managedByScim: false, grantsOrganizationAdmin: false,
};

function sharing({ orgWide = false, disabled = false, canShareWithEveryone = true } = {}) {
  return renderToStaticMarkup(<WhoCanUseIt
    value={{ orgWide, memberIds: ["owner", person.id], teamIds: [team.id] }}
    onChange={() => { throw new Error("Rendering must not write access"); }}
    members={[person]} teams={[team]}
    owner={{ id: "owner", name: "Sam Example", isYou: false }}
    canShareWithEveryone={canShareWithEveryone} disabled={disabled}
  />);
}

function control(html: string, attribute: string) {
  const found = html.match(new RegExp(`<button[^>]*${attribute}[^>]*>`));
  assert.ok(found, attribute);
  return found[0];
}

test("read-only sharing keeps the audience, owner and all controls visible but disabled", () => {
  const html = sharing({ disabled: true });
  assert.match(html, /Alex Example/);
  assert.match(html, /alex@example.test/);
  assert.match(html, /Design/);
  assert.match(html, /Can change and remove it/);
  for (const attribute of [
    'data-testid="access-everyone"',
    'aria-label="Remove Alex Example"',
    'aria-label="Remove Design"',
    'data-testid="access-add-person"',
    'data-testid="access-add-team"',
  ]) assert.match(control(html, attribute), /disabled=""/);
  assert.doesNotMatch(html, /aria-label="Remove Sam Example"/);
});

test("Everyone permission only blocks granting Everyone, not revoking an existing grant", () => {
  const off = sharing({ canShareWithEveryone: false });
  assert.match(control(off, 'data-testid="access-everyone"'), /disabled=""/);
  assert.doesNotMatch(control(off, 'data-testid="access-add-person"'), /disabled=""/);
  const on = sharing({ orgWide: true, canShareWithEveryone: false });
  assert.match(control(on, 'data-testid="access-everyone"'), /aria-checked="true"/);
  assert.doesNotMatch(control(on, 'data-testid="access-everyone"'), /disabled=""/);
  assert.doesNotMatch(on, /data-testid="access-person"|data-testid="access-team"/);
});

test("the shared row accepts a specialized identity without discarding grant metadata", () => {
  const html = renderToStaticMarkup(<AccessRow
    title={<div><p>Alex Example</p><span>Invited</span></div>}
    description="Shared by Sam Example · Jan 2, 2026"
    trailing={<><span>Editor</span><RemoveButton actionLabel="Revoke" label="Revoke access for Alex Example" disabled onClick={() => undefined} /></>}
  />);
  for (const text of ["Invited", "Editor", "Shared by Sam Example", "Jan 2, 2026", "Revoke"]) assert.ok(html.includes(text), text);
  assert.match(control(html, 'aria-label="Revoke access for Alex Example"'), /disabled=""/);
  assert.doesNotMatch(html, /<p[^>]*><div/);
});

test("draft and grant pickers can share button styling without sharing selection semantics", () => {
  const html = renderToStaticMarkup(<AddPicker kind="person" options={[]} disabled onAdd={() => undefined} />);
  const trigger = control(html, 'data-testid="access-add-person"');
  assert.ok(trigger.includes(accessAddButtonClassName));
  assert.match(trigger, /disabled=""/);
  assert.match(html, /Add person/);
});
