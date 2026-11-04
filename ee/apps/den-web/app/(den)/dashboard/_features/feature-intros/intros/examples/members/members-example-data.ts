/** Sample data only: no API calls (DESIGN.md I7). */

export type MembersExampleRow = {
  initials: string;
  name: string;
  /** Email, as the member list shows under the name. */
  email: string;
  /** Role column, as on Members. */
  role: string;
  /** Teams they're in, quiet chips. */
  teams: readonly string[];
  /** "Joined" column: a date, or Pending for an invite. */
  joined: string;
  pending?: boolean;
};

export const membersExampleRows: readonly MembersExampleRow[] = [
  { initials: "AL", name: "Ada Lovelace", email: "ada@acme.com", role: "Owner", teams: [], joined: "Mar 4" },
  { initials: "GH", name: "Grace Hopper", email: "grace@acme.com", role: "Admin", teams: ["Engineering"], joined: "Mar 6" },
  { initials: "SL", name: "Sam Lee", email: "sam@acme.com", role: "Member", teams: ["Support", "Sales"], joined: "Apr 12" },
  { initials: "PS", name: "priya@acme.com", email: "Invite sent", role: "Member", teams: ["Engineering"], joined: "Pending", pending: true },
];

export const membersExampleCount = "3 members, 1 invite";
