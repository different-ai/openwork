// Validate the public response, independently of the implementation's parser.
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}

function adminTeams(value: unknown) {
  return list(value).map((entry) => {
    const row = record(entry);
    return { id: text(row.id), name: text(row.name) };
  });
}

export function parseTeamAdminContext(value: unknown) {
  const body = record(value);
  const organization = record(body.organization);
  const current = record(body.currentMember);
  return {
    organization: { id: text(organization.id), name: text(organization.name) },
    currentMember: {
      id: text(current.id), userId: text(current.userId), role: text(current.role),
      directRole: text(current.directRole), isOwner: current.isOwner === true, adminTeams: adminTeams(current.adminTeams),
    },
    members: list(body.members).map((entry) => {
      const row = record(entry);
      const user = record(row.user);
      return { id: text(row.id), userId: row.userId === null ? null : text(row.userId), inviteId: row.inviteId === null ? null : text(row.inviteId), role: text(row.role), effectiveRole: text(row.effectiveRole), user: { email: text(user.email), name: text(user.name) } };
    }),
    teams: list(body.teams).map((entry) => {
      const row = record(entry);
      return { id: text(row.id), name: text(row.name), memberIds: list(row.memberIds).map(text), grantsOrganizationAdmin: row.grantsOrganizationAdmin === true, managedByScim: row.managedByScim === true };
    }),
    invitations: list(body.invitations).map((entry) => {
      const row = record(entry);
      return { id: text(row.id), status: text(row.status) };
    }),
  };
}
