import { ShieldCheck, Users, UsersRound } from "lucide-react";
import { getMembersRoute, getNewRoleRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext, type FeatureIntroCta } from "../types";
import { docsPage } from "./docs";
import { MembersExample } from "./examples/members/members-example";
import { CustomRoleExample, RolesExample } from "./examples/members/roles-example";
import { TeamsExample } from "./examples/members/teams-example";

/**
 * Facts the Members page reports from data it already loads (`GET /v1/org`
 * and, for people who can view permissions, the permission sets). A missing
 * fact means "not loaded yet": a section never takes over the page on a guess.
 */
export type MembersFacts = {
  /** Rows on the Members tab: joined people and pending invites, the viewer included. */
  people?: number;
  /** Invitations still waiting to be accepted. */
  pendingInvites?: number;
  teams?: number;
  /** Custom roles (`kind: "team"` permission sets); only reported to people who can view permissions. */
  customRoles?: number;
};

type Ctx = FeatureIntroContext<MembersFacts>;

const PATH = getMembersRoute();
const DOCS = "cloud/members-and-rbac";
/** `?invite=1` opens the invite form with the email field focused (DESIGN.md I5). */
export const MEMBERS_INVITE_ROUTE = `${PATH}?invite=1`;
/** `?tab=teams&newTeam=1` opens the Create team form. */
export const MEMBERS_NEW_TEAM_ROUTE = `${PATH}?tab=teams&newTeam=1`;

function membersSetUp(ctx: Ctx): boolean {
  return (ctx.facts.people ?? 0) > 1 || (ctx.facts.pendingInvites ?? 0) > 0 || (ctx.facts.teams ?? 0) > 0;
}

/** Creating a role needs Manage teams and Manage permissions (`canCreateRole`); say which one is missing. */
const createRoleCtas: readonly FeatureIntroCta<MembersFacts>[] = [
  { when: (ctx) => ctx.can("canManagePermissions") && ctx.can("canManageTeams"), label: "Create a custom role", href: getNewRoleRoute() },
  { when: (ctx) => !ctx.can("canManagePermissions"), label: "Create a custom role", href: getNewRoleRoute(), locked: { reason: permissionLockReason("permissions.manage") } },
  { when: () => true, label: "Create a custom role", href: getNewRoleRoute(), locked: { reason: permissionLockReason("teams.manage") } },
];

export const membersIntros = [
  defineFeatureIntro<MembersFacts>({
    key: "members",
    version: 1,
    match: { path: PATH },
    icon: Users,
    title: "Members",
    summary: "Bring your team into OpenWork and decide what each person can do.",
    highlights: [
      { title: "Invite by email.", text: "Each invite works for that one address. Copy its link if you'd rather send it yourself." },
      { title: "Owner, admins and members.", text: "Admins invite people and run teams, connections and models. Members use what's shared with them." },
      { title: "Teams share access.", text: "Give AI providers, plugins and connectors to a whole team instead of one person at a time." },
      { title: "Remove someone in one step.", text: "They lose access to the organization, and you can invite them again later." },
    ],
    example: {
      Component: MembersExample,
      alt: "Example: Ada Lovelace as owner, Grace Hopper as an admin in Engineering, Sam Lee as a member in Support and Sales, and a pending invite for priya@acme.com.",
    },
    docsUrl: docsPage(DOCS),
    ctas: [
      { when: (ctx) => ctx.can("canInviteMembers"), label: "Invite your team", href: MEMBERS_INVITE_ROUTE },
      { when: () => true, label: "Invite your team", href: MEMBERS_INVITE_ROUTE, locked: { reason: permissionLockReason("invitations.manage") } },
    ],
    // Full screen only once the organization is known: the viewer alone, no invites and no teams.
    setupState: (ctx) => {
      if (ctx.facts.people === undefined) return "done";
      return membersSetUp(ctx) ? "done" : "none";
    },
  }),

  defineFeatureIntro<MembersFacts>({
    key: "members.teams",
    parent: "members",
    version: 1,
    match: { path: PATH, tab: "teams" },
    icon: UsersRound,
    title: "Teams",
    summary: "Group people so they get the same role, models, plugins and connectors together.",
    highlights: [
      { title: "Share once.", text: "Give a team AI providers, plugins and connectors, and everyone in it gets them." },
      { title: "A role for the team.", text: "Keep it Member, make it an Admin team, or give it a custom role with extra permissions." },
      { title: "Or from your identity provider.", text: "With user provisioning, teams can follow the groups in your identity provider." },
    ],
    example: {
      Component: TeamsExample,
      alt: "Example: Everyone with 35 members, then Engineering, Sales and Operations, each with its size, role, plugin, AI providers and connectors.",
    },
    docsUrl: docsPage(`${DOCS}#create-teams`),
    ctas: [
      { when: (ctx) => ctx.can("canManageTeams"), label: "Create a team", href: MEMBERS_NEW_TEAM_ROUTE },
      { when: () => true, label: "Create a team", href: MEMBERS_NEW_TEAM_ROUTE, locked: { reason: permissionLockReason("teams.manage") } },
    ],
    setupState: (ctx) => {
      if (ctx.facts.teams === undefined) return "done";
      return ctx.facts.teams > 0 ? "done" : "none";
    },
  }),

  defineFeatureIntro<MembersFacts>({
    key: "members.roles",
    parent: "members",
    version: 1,
    match: { path: PATH, tab: "roles" },
    icon: ShieldCheck,
    title: "Custom roles",
    summary: "Give a team exactly the extra permissions it needs, without making everyone in it an admin.",
    highlights: [
      { title: "Starts from Member.", text: "A new role adds only the permissions you turn on." },
      { title: "Given through teams.", text: "Everyone in a team with the role gets it, and one role can be on several teams." },
      { title: "Built-in roles stay.", text: "Owner, Admin and Member are always there." },
    ],
    example: {
      Component: CustomRoleExample,
      alt: "Example: a Team lead role on Engineering and Sales that adds Invite people, Share with everyone and View usage analytics.",
    },
    docsUrl: docsPage(`${DOCS}#custom-roles`),
    ctas: createRoleCtas,
    // Box in place of the empty Custom roles list. Unknown (or no permission to view roles) shows nothing.
    setupState: (ctx) => {
      if (ctx.facts.customRoles === undefined) return "done";
      return ctx.facts.customRoles > 0 ? "done" : "none";
    },
  }),

  defineFeatureIntro<MembersFacts>({
    key: "members.roles.new",
    version: 1,
    // Never shown on its own: this form is the setup step. It answers `?` on Create role.
    match: { path: getNewRoleRoute() },
    icon: ShieldCheck,
    title: "Create a custom role",
    summary: "Name a role, turn on what it adds to Member, and give it to the teams that need it.",
    highlights: [
      { title: "Starts with nothing extra.", text: "Turn on only the permissions this role should add." },
      { title: "Only what you have.", text: "You can give a role permissions you hold yourself." },
      { title: "One role, many teams.", text: "Giving it to a team replaces that team's custom role." },
    ],
    example: {
      Component: RolesExample,
      alt: "Example: a Team lead role on Engineering and Sales that adds Invite people, Share with everyone and View usage analytics.",
    },
    docsUrl: docsPage(`${DOCS}#custom-roles`),
    ctas: createRoleCtas,
    setupState: () => "done",
  }),
];
