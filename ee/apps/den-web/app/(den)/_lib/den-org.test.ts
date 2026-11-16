import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOrgContextPayload } from "./den-org";

const timestamp = "2026-01-01T12:00:00.000Z";

function member(index: number) {
  return {
    id: `member-${index}`,
    userId: `user-${index}`,
    inviteId: null,
    role: "member",
    effectiveRole: "member",
    adminTeams: [],
    createdAt: timestamp,
    joinedAt: timestamp,
    isOwner: false,
    openworkWeb: index % 2 === 0,
    user: {
      id: `user-${index}`,
      email: `member-${index}@example.test`,
      name: `Member ${index}`,
      image: null,
    },
  };
}

function payload(members: unknown[]) {
  return {
    organization: { id: "org-example", name: "Example workspace", slug: "example-workspace" },
    currentMember: { id: "member-owner", userId: "user-owner", role: "admin" },
    members,
  };
}

test("ten joined members retain their identities and access when five have no display name", () => {
  const members = Array.from({ length: 10 }, (_, index) => {
    const entry = member(index);
    return { ...entry, user: { ...entry.user, name: index < 5 ? entry.user.name : "" } };
  });
  const context = parseOrgContextPayload(payload(members));
  assert.ok(context);
  assert.equal(context.members.length, 10);
  assert.deepEqual(context.members, members.map((entry, index) => ({
    ...entry,
    user: { ...entry.user, name: index < 5 ? `Member ${index}` : `member-${index}@example.test` },
  })));
});

test("blank or absent display names use email without dropping a valid member", () => {
  const entry = member(1);
  for (const name of ["", " \t\n ", null, undefined, 42, false, {}, []]) {
    const context = parseOrgContextPayload(payload([{ ...entry, user: { ...entry.user, name } }]));
    assert.ok(context);
    assert.deepEqual(context.members, [{ ...entry, user: { ...entry.user, name: entry.user.email } }]);
  }

  const context = parseOrgContextPayload(payload([{
    ...entry,
    user: { id: entry.user.id, email: entry.user.email, image: null },
  }]));
  assert.ok(context);
  assert.equal(context.members[0]?.user.name, entry.user.email);
});

test("ordinary display names, including surrounding whitespace, are preserved", () => {
  const entry = member(2);
  for (const name of ["Member Two", "  Member Two  ", entry.user.email]) {
    const named = { ...entry, user: { ...entry.user, name } };
    const context = parseOrgContextPayload(payload([named]));
    assert.ok(context);
    assert.deepEqual(context.members, [named]);
  }
});

test("email fallback does not admit records missing required membership or linked-user fields", () => {
  const entry = member(3);
  const unnamed = { ...entry, user: { ...entry.user, name: "" } };
  const invalid: unknown[] = [null, undefined, false, [], {}, { ...unnamed, user: null }, { ...unnamed, user: [] }];
  for (const value of ["", null, undefined, 42]) {
    invalid.push(
      { ...unnamed, id: value },
      { ...unnamed, role: value },
      { ...unnamed, user: { ...unnamed.user, id: value } },
      { ...unnamed, user: { ...unnamed.user, email: value } },
    );
  }
  const context = parseOrgContextPayload(payload([entry, ...invalid]));
  assert.ok(context);
  assert.deepEqual(context.members, [entry]);
});

test("pending invitations and team membership references remain intact", () => {
  const joined = member(4);
  const pending = {
    ...member(5),
    userId: null,
    inviteId: "invite-pending",
    joinedAt: null,
    user: { ...member(5).user, name: "" },
  };
  const invitation = {
    id: "invite-pending",
    email: pending.user.email,
    role: "member",
    status: "pending",
    expiresAt: timestamp,
    createdAt: timestamp,
  };
  const team = {
    id: "team-example",
    name: "Example team",
    createdAt: timestamp,
    updatedAt: timestamp,
    memberIds: [joined.id, pending.id],
    managedByScim: false,
    grantsOrganizationAdmin: false,
  };
  const context = parseOrgContextPayload({
    ...payload([joined, pending]),
    invitations: [invitation],
    teams: [team],
  });
  assert.ok(context);
  assert.deepEqual(context.members, [joined, { ...pending, user: { ...pending.user, name: pending.user.email } }]);
  assert.deepEqual(context.invitations, [invitation]);
  assert.deepEqual(context.teams, [team]);
  assert.deepEqual(context.teams[0]?.memberIds, context.members.map((entry) => entry.id));
});

test("organization and current-member requirements still fail closed", () => {
  const input = payload([member(6)]);
  for (const value of ["", null, undefined, 42]) {
    for (const key of ["id", "name", "slug"]) {
      assert.equal(parseOrgContextPayload({ ...input, organization: { ...input.organization, [key]: value } }), null);
    }
    for (const key of ["id", "userId", "role"]) {
      assert.equal(parseOrgContextPayload({ ...input, currentMember: { ...input.currentMember, [key]: value } }), null);
    }
  }
});
