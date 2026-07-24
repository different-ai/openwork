import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "cloud-super-admins";

// Narration is loaded from the approved script (evals/voiceovers/cloud-super-admins.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

type ApiRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type ApiResult = {
  response: Response;
  body: unknown;
  text: string;
};

type JsonObject = Record<string, unknown>;

type FixtureActor = {
  email: string;
  name: string;
  password: string;
};

type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
  isActive: boolean;
};

type OrgMember = {
  id: string;
  email: string;
  name: string;
  role: string;
  joinedAt: string | null;
  isOwner: boolean;
};

type OrgInvitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  inviteToken: string | null;
};

type OrgRole = {
  id: string;
  role: string;
  protected: boolean;
};

type OrgContext = {
  organization: {
    id: string;
    name: string;
    slug: string;
    ownerEmail: string | null;
  };
  currentMember: {
    id: string;
    role: string;
    isOwner: boolean;
  };
  members: OrgMember[];
  invitations: OrgInvitation[];
  roles: OrgRole[];
};

type RoleCounts = {
  owners: number;
  superAdmins: number;
  admins: number;
  members: number;
};

type FlowState = {
  prepared: boolean;
  promoted: boolean;
  orgId: string | null;
  orgSlug: string | null;
  orgNameBeforeMutation: string | null;
  orgNameMutation: string | null;
  ownerMemberId: string | null;
  adminMemberId: string | null;
  memberMemberId: string | null;
  secondAdminMemberId: string | null;
  ownerBeforeTransferEmail: string | null;
  ownerAfterTransferEmail: string | null;
};

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const DEFAULT_PASSWORD = process.env.OPENWORK_EVAL_SUPER_ADMINS_PASSWORD?.trim() || "OpenWorkDemo123!";
const FIXTURE_ORG_NAME = process.env.OPENWORK_EVAL_SUPER_ADMINS_ORG_NAME?.trim() || "Cloud Super Admins Eval";

const OWNER: FixtureActor = {
  email: process.env.OPENWORK_EVAL_SUPER_ADMINS_OWNER_EMAIL?.trim() || "casey.owner.super-admins@openwork.test",
  name: "Casey Owner",
  password: process.env.OPENWORK_EVAL_SUPER_ADMINS_OWNER_PASSWORD?.trim() || DEFAULT_PASSWORD,
};

const ADMIN: FixtureActor = {
  email: process.env.OPENWORK_EVAL_SUPER_ADMINS_ADMIN_EMAIL?.trim() || "riley.admin.super-admins@openwork.test",
  name: "Riley Admin",
  password: process.env.OPENWORK_EVAL_SUPER_ADMINS_ADMIN_PASSWORD?.trim() || DEFAULT_PASSWORD,
};

const SECOND_ADMIN: FixtureActor = {
  email: process.env.OPENWORK_EVAL_SUPER_ADMINS_SECOND_ADMIN_EMAIL?.trim() || "taylor.admin.super-admins@openwork.test",
  name: "Taylor Admin",
  password: process.env.OPENWORK_EVAL_SUPER_ADMINS_SECOND_ADMIN_PASSWORD?.trim() || DEFAULT_PASSWORD,
};

const MEMBER: FixtureActor = {
  email: process.env.OPENWORK_EVAL_SUPER_ADMINS_MEMBER_EMAIL?.trim() || "morgan.member.super-admins@openwork.test",
  name: "Morgan Member",
  password: process.env.OPENWORK_EVAL_SUPER_ADMINS_MEMBER_PASSWORD?.trim() || DEFAULT_PASSWORD,
};

const ACTORS: FixtureActor[] = [OWNER, ADMIN, SECOND_ADMIN, MEMBER];
const tokenByEmail = new Map<string, string>();
const state: FlowState = {
  prepared: false,
  promoted: false,
  orgId: null,
  orgSlug: null,
  orgNameBeforeMutation: null,
  orgNameMutation: null,
  ownerMemberId: null,
  adminMemberId: null,
  memberMemberId: null,
  secondAdminMemberId: null,
  ownerBeforeTransferEmail: null,
  ownerAfterTransferEmail: null,
};

const SIDEBAR_TOP_LEVEL = ["Dashboard", "Extensions", "Models", "Members", "Analytics", "Settings"];
const EXTENSIONS_CHILDREN = ["Marketplace", "Sources", "Plugins", "Connectors"];
const MODELS_CHILDREN = ["OpenWork Models", "LLM Providers"];
const SETTINGS_CHILDREN = ["General", "Diagnostics", "Brand appearance", "Desktop Policies", "Stripe", "API Keys", "SSO", "SCIM"];

export default defineFlow({
  id: FLOW_ID,
  title: "Cloud super admins: owners, super-admins, admins, and members see the right Den Web controls and API permissions",
  kind: "user-facing",
  spec: "evals/voiceovers/cloud-super-admins.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Den Web sidebar groups workspace areas into Extensions, Models, Members, Analytics, and Settings", {
          voiceover: vo[0],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToDenWebWithOrg(ctx, OWNER.email, OWNER.password);
            await goToDenWeb(ctx, "/dashboard/marketplaces");
            const extensions = await visibleSidebarChildren(ctx);
            await goToDenWeb(ctx, "/dashboard/inference");
            const models = await visibleSidebarChildren(ctx);
            await goToDenWeb(ctx, "/dashboard/org-settings");
            const settings = await visibleSidebarChildren(ctx);
            ctx.output("sidebar-group-labels", JSON.stringify({ extensions, models, settings }, null, 2));
          },
          assert: async () => {
            const navText = await getNavText(ctx);
            for (const label of SIDEBAR_TOP_LEVEL) {
              ctx.assert(navText.includes(label), `Sidebar top-level label missing: ${label}`);
            }
            const settings = await visibleSidebarChildren(ctx);
            assertStringListIncludes(ctx, settings, SETTINGS_CHILDREN, "Settings sidebar children");

            await goToDenWeb(ctx, "/dashboard/marketplaces");
            assertStringListIncludes(ctx, await visibleSidebarChildren(ctx), EXTENSIONS_CHILDREN, "Extensions sidebar children");
            await goToDenWeb(ctx, "/dashboard/inference");
            assertStringListIncludes(ctx, await visibleSidebarChildren(ctx), MODELS_CHILDREN, "Models sidebar children");
            await goToDenWeb(ctx, "/dashboard/org-settings");
          },
          screenshot: {
            name: "sidebar-role-hierarchy-map",
            claim: "The sidebar visibly groups Settings under the new role hierarchy while assertions cover every child label in Extensions and Models too.",
            requireText: ["Extensions", "Models", "Members", "Analytics", "Settings", "General", "Diagnostics", "Brand appearance", "Desktop Policies", "Stripe", "API Keys", "SSO", "SCIM"],
            rejectText: ["Something went wrong", "MCP Connections"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Admins keep operational access across Den Web but cannot edit organization roles", {
          voiceover: vo[1],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToDenWebWithOrg(ctx, ADMIN.email, ADMIN.password);
            await goToDenWeb(ctx, "/dashboard/marketplaces");
            await expectPageText(ctx, ["Marketplace"]);
            await goToDenWeb(ctx, "/dashboard/integrations");
            await expectPageText(ctx, ["Sources"]);
            await goToDenWeb(ctx, "/dashboard/plugins");
            await expectPageText(ctx, ["Plugins"]);
            await goToDenWeb(ctx, "/dashboard/mcp-connections");
            await expectPageText(ctx, ["Connectors"]);
            await goToDenWeb(ctx, "/dashboard/custom-llm-providers");
            await expectPageText(ctx, ["LLM Providers"]);
            await goToDenWeb(ctx, "/dashboard/analytics");
            await expectPageText(ctx, ["Analytics"]);
            await goToDenWeb(ctx, "/dashboard/members");
            await openMembersTab(ctx);
            await openMemberActions(ctx, MEMBER.email);
          },
          assert: async () => {
            await ctx.expectText("Members", { timeoutMs: 20_000 });
            await ctx.expectText("Add member", { timeoutMs: 20_000 });
            await ctx.expectText("Manage teams", { timeoutMs: 20_000 });
            await ctx.expectText("Remove member", { timeoutMs: 20_000 });
            await ctx.expectNoText("Edit role");

            const adminToken = await tokenForActor(ctx, ADMIN);
            await setActiveOrganization(ctx, adminToken);
            const roleAttempt = await updateMemberRoleApi(ctx, adminToken, requireStateString(state.memberMemberId, "member id"), "admin");
            ctx.assert(roleAttempt.response.status === 403, `Admin role update should be rejected with 403, saw ${roleAttempt.response.status}: ${roleAttempt.text.slice(0, 240)}`);
            ctx.output("admin-operational-role-denial", JSON.stringify({ roleUpdateStatus: roleAttempt.response.status }, null, 2));
          },
          screenshot: {
            name: "admin-operational-no-role-editing",
            claim: "An admin can open Members and act on eligible members, but the role editor is absent and direct role writes are denied.",
            requireText: ["Members", "Add member", "Manage teams", "Remove member"],
            rejectText: ["Edit role", "Only workspace owners and super-admins can change member roles"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Admins can read every Settings page while UI controls and direct Settings writes stay read-only", {
          voiceover: vo[2],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToDenWebWithOrg(ctx, ADMIN.email, ADMIN.password);
            await visitSettingsReadOnlyPages(ctx);
            await goToDenWeb(ctx, "/dashboard/org-settings");
          },
          assert: async () => {
            const disabled = await readGeneralSettingsControlState(ctx);
            ctx.assert(disabled.nameInputDisabled, "Admin should see the organization name input disabled.");
            ctx.assert(disabled.saveButtonDisabled, "Admin should see Save settings disabled.");

            const adminToken = await tokenForActor(ctx, ADMIN);
            await setActiveOrganization(ctx, adminToken);
            const denied = await patchOrganizationName(ctx, adminToken, `${FIXTURE_ORG_NAME} admin-denied`);
            ctx.assert(denied.response.status === 403, `Admin settings write should be rejected with 403, saw ${denied.response.status}: ${denied.text.slice(0, 240)}`);
            ctx.output("admin-settings-write-denial", JSON.stringify({ patchOrgStatus: denied.response.status, controls: disabled }, null, 2));
          },
          screenshot: {
            name: "admin-settings-read-only",
            claim: "The admin can read Settings but sees disabled controls and the read-only explanation.",
            requireText: ["Org settings", "Organization Identity", "Admins can view settings here. Owners and super-admins can change them.", "Save settings"],
            rejectText: ["Workspace settings updated.", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The owner can promote admins or members to super-admin while other admins remain admins", {
          voiceover: vo[3],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToDenWebWithOrg(ctx, OWNER.email, OWNER.password);
            await goToDenWeb(ctx, "/dashboard/members");
            await setMemberRoleInUi(ctx, ADMIN.email, "super-admin");
            await setMemberRoleInUi(ctx, MEMBER.email, "super-admin");
            state.promoted = true;
          },
          assert: async () => {
            const ownerToken = await tokenForActor(ctx, OWNER);
            await setActiveOrganization(ctx, ownerToken);
            const context = await fetchOrgContext(ctx, ownerToken);
            const counts = roleCounts(context.members);
            ctx.assert(counts.owners === 1, `Expected one owner after promotions, saw ${counts.owners}.`);
            ctx.assert(counts.superAdmins >= 2, `Expected at least two super-admins, saw ${counts.superAdmins}.`);
            ctx.assert(counts.admins >= 1, `Expected at least one remaining admin, saw ${counts.admins}.`);
            ctx.output("owner-promoted-super-admins", JSON.stringify({ counts, members: summarizeMembers(context.members) }, null, 2));
          },
          screenshot: {
            name: "owner-promotes-super-admins",
            claim: "The Members table shows two super-admins and another admin in the same workspace.",
            requireText: ["Members", OWNER.name, ADMIN.name, MEMBER.name, SECOND_ADMIN.name, "Super Admin", "Admin"],
            rejectText: ["Only workspace owners and super-admins can change member roles", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("A super-admin can mutate Settings safely and sees member role controls", {
          voiceover: vo[4],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await ensurePromotedRoles(ctx);
            await signInToDenWebWithOrg(ctx, ADMIN.email, ADMIN.password);
            await goToDenWeb(ctx, "/dashboard/org-settings");
            state.orgNameBeforeMutation = await currentOrganizationName(ctx, ADMIN.email);
            state.orgNameMutation = `${FIXTURE_ORG_NAME} — super-admin verified`;
            await updateOrganizationNameInUi(ctx, state.orgNameMutation);
            await visitSuperAdminSettingsPages(ctx);
            await goToDenWeb(ctx, "/dashboard/members");
            await openMembersTab(ctx);
            await openMemberRoleEditor(ctx, MEMBER.email);
          },
          assert: async () => {
            const adminToken = await tokenForActor(ctx, ADMIN);
            await setActiveOrganization(ctx, adminToken);
            const context = await fetchOrgContext(ctx, adminToken);
            ctx.assert(context.organization.name === state.orgNameMutation, `Super-admin settings mutation did not persist; saw ${context.organization.name}.`);
            const roleEditor = await readRoleEditorState(ctx);
            ctx.assert(roleEditor.visible, "Super-admin should see the member role editor.");
            ctx.assert(roleEditor.canSave, "Super-admin Save member button should be enabled.");
            ctx.assert(roleEditor.options.includes("super-admin") && roleEditor.options.includes("admin") && roleEditor.options.includes("member"), `Role editor options were incomplete: ${JSON.stringify(roleEditor.options)}`);
            ctx.output("super-admin-settings-and-role-controls", JSON.stringify({ organizationName: context.organization.name, roleEditor }, null, 2));
          },
          screenshot: {
            name: "super-admin-member-role-ui",
            claim: "The super-admin sees an enabled member role editor after a successful Settings mutation.",
            requireText: ["Members", "Role", "Save member", MEMBER.name, "Super Admin"],
            rejectText: ["Admins can view settings here", "Read only: owners and super-admins"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("The owner remains locked: super-admins cannot delete it, change its role, or transfer ownership", {
          voiceover: vo[5],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await ensurePromotedRoles(ctx);
            await signInToDenWebWithOrg(ctx, ADMIN.email, ADMIN.password);
            await goToDenWeb(ctx, "/dashboard/members");
            await openMembersTab(ctx);
            await scrollMemberIntoView(ctx, OWNER.email);
          },
          assert: async () => {
            await ctx.expectText("Locked", { timeoutMs: 20_000 });
            const ownerActionsVisible = await memberActionButtonVisible(ctx, OWNER.email);
            ctx.assert(!ownerActionsVisible, "Owner row should not expose the member action menu.");

            const adminToken = await tokenForActor(ctx, ADMIN);
            await setActiveOrganization(ctx, adminToken);
            const ownerId = requireStateString(state.ownerMemberId, "owner member id");
            const ownerRoleUpdate = await updateMemberRoleApi(ctx, adminToken, ownerId, "admin");
            const ownerDelete = await deleteMemberApi(ctx, adminToken, ownerId);
            const transferAttempt = await transferOwnershipApi(ctx, adminToken, requireStateString(state.memberMemberId, "member id"));
            ctx.assert([400, 403].includes(ownerRoleUpdate.response.status), `Owner role update should fail, saw ${ownerRoleUpdate.response.status}.`);
            ctx.assert([400, 403].includes(ownerDelete.response.status), `Owner deletion should fail, saw ${ownerDelete.response.status}.`);
            ctx.assert(transferAttempt.response.status === 403, `Super-admin transfer should be rejected with 403, saw ${transferAttempt.response.status}.`);
            ctx.output("owner-protection-api", JSON.stringify({
              ownerRoleUpdateStatus: ownerRoleUpdate.response.status,
              ownerDeleteStatus: ownerDelete.response.status,
              superAdminTransferStatus: transferAttempt.response.status,
            }, null, 2));
          },
          screenshot: {
            name: "owner-row-locked",
            claim: "The owner row is locked and exposes no action menu to a super-admin.",
            requireText: ["Members", OWNER.name, OWNER.email, "Owner", "Locked"],
            rejectText: ["Transfer ownership", "Remove member"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("The owner transfers ownership to a super-admin and becomes a super-admin", {
          voiceover: vo[6],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await ensurePromotedRoles(ctx);
            state.ownerBeforeTransferEmail = OWNER.email;
            state.ownerAfterTransferEmail = ADMIN.email;
            await signInToDenWebWithOrg(ctx, OWNER.email, OWNER.password);
            await goToDenWeb(ctx, "/dashboard/members");
            await openMembersTab(ctx);
            await transferOwnershipInUi(ctx, ADMIN.email);
          },
          assert: async () => {
            const adminToken = await tokenForActor(ctx, ADMIN);
            await setActiveOrganization(ctx, adminToken);
            const context = await fetchOrgContext(ctx, adminToken);
            const counts = roleCounts(context.members);
            const newOwner = findMemberByEmail(context, ADMIN.email);
            const previousOwner = findMemberByEmail(context, OWNER.email);
            ctx.assert(counts.owners === 1, `Exactly one owner must remain after transfer, saw ${counts.owners}.`);
            ctx.assert(newOwner?.isOwner === true, `${ADMIN.email} should be the new owner.`);
            ctx.assert(previousOwner?.isOwner === false && roleIncludes(previousOwner.role, "super-admin"), `${OWNER.email} should become a super-admin after transfer.`);
            ctx.output("owner-transfer-result", JSON.stringify({ counts, members: summarizeMembers(context.members) }, null, 2));
          },
          screenshot: {
            name: "ownership-transferred",
            claim: "After transfer, the chosen super-admin is the only owner and the previous owner is a super-admin.",
            requireText: ["Members", ADMIN.name, OWNER.name, "Owner", "Super Admin"],
            rejectText: ["Could not transfer ownership", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        try {
          await ctx.prove("The visible Roles summary plus API evidence documents owner, super-admin, admin, and member enforcement", {
            voiceover: vo[7],
            action: async () => {
              await ensureFixturePrepared(ctx);
              await signInToDenWebWithOrg(ctx, OWNER.email, OWNER.password);
              await goToDenWeb(ctx, "/dashboard/members");
              await openRolesTab(ctx);
            },
            assert: async () => {
              const currentOwnerToken = await tokenForActor(ctx, ADMIN);
              await setActiveOrganization(ctx, currentOwnerToken);
              const postTransfer = await fetchOrgContext(ctx, currentOwnerToken);
              const counts = roleCounts(postTransfer.members);
              ctx.assert(counts.owners === 1, `Role summary must still have exactly one owner, saw ${counts.owners}.`);
              ctx.assert(findMemberByEmail(postTransfer, ADMIN.email)?.isOwner === true, "Transferred owner should remain owner for the role summary evidence.");
              ctx.assert(findMemberByEmail(postTransfer, OWNER.email)?.isOwner === false, "Previous owner should remain demoted for the role summary evidence.");

              const originalOwnerToken = await tokenForActor(ctx, OWNER);
              await setActiveOrganization(ctx, originalOwnerToken);
              const previousOwnerSettings = await patchOrganizationName(ctx, originalOwnerToken, state.orgNameMutation || FIXTURE_ORG_NAME);
              ctx.assert(previousOwnerSettings.response.ok, `Previous owner as super-admin should still be able to update settings before cleanup, saw ${previousOwnerSettings.response.status}.`);

              const adminToken = await tokenForActor(ctx, SECOND_ADMIN);
              await setActiveOrganization(ctx, adminToken);
              const adminSettings = await patchOrganizationName(ctx, adminToken, `${FIXTURE_ORG_NAME} admin-summary-denied`);
              ctx.assert(adminSettings.response.status === 403, `Admin settings write should remain denied, saw ${adminSettings.response.status}.`);

              const memberBoundary = findMemberByEmail(postTransfer, MEMBER.email);
              ctx.assert(Boolean(memberBoundary), "Member boundary actor should be present before the member API check.");
              if (memberBoundary && !memberBoundary.isOwner && !roleIncludes(memberBoundary.role, "member")) {
                await updateMemberRoleExpectOk(ctx, currentOwnerToken, memberBoundary.id, "member");
              }
              const memberToken = await tokenForActor(ctx, MEMBER);
              await setActiveOrganization(ctx, memberToken);
              const memberSettings = await patchOrganizationName(ctx, memberToken, `${FIXTURE_ORG_NAME} member-summary-denied`);
              ctx.assert(memberSettings.response.status === 403, `Member settings write should be denied, saw ${memberSettings.response.status}.`);

              ctx.output("role-enforcement-summary", JSON.stringify({
                visibleRoute: "/dashboard/members Roles tab",
                guideRouteClaimed: false,
                counts,
                api: {
                  ownerControlsOwnership: true,
                  previousOwnerSuperAdminSettingsStatus: previousOwnerSettings.response.status,
                  adminSettingsWriteStatus: adminSettings.response.status,
                  memberSettingsWriteStatus: memberSettings.response.status,
                },
                members: summarizeMembers(postTransfer.members),
              }, null, 2));
            },
            screenshot: {
              name: "roles-summary-and-api-evidence",
              claim: "No separate access-guide route is claimed; the Roles tab and output evidence summarize the same enforcement matrix.",
              requireText: ["Roles", "Owner", "Super Admin", "Admin", "Member", "System"],
              rejectText: ["Something went wrong"],
            },
          });
        } finally {
          await restoreFixtureState(ctx).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Unknown cleanup error.";
            ctx.output("cleanup-warning", `Fixture cleanup attempted after frame 8 but did not fully complete: ${message}`);
          });
        }
      },
    },
  ],
});

function cleanBaseUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function booleanField(record: JsonObject, key: string): boolean {
  return record[key] === true;
}

function recordField(record: JsonObject, key: string): JsonObject | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function arrayField(record: JsonObject, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireStateString(value: string | null, label: string): string {
  if (value) return value;
  throw new Error(`${label} was not prepared.`);
}

function actorForEmail(email: string): FixtureActor | null {
  const normalized = email.toLowerCase();
  return ACTORS.find((actor) => actor.email.toLowerCase() === normalized) ?? null;
}

function fixtureOrgNameMatches(name: string): boolean {
  return name === FIXTURE_ORG_NAME || name.startsWith(`${FIXTURE_ORG_NAME} —`);
}

async function denApiFetch(pathname: string, options: ApiRequestOptions = {}): Promise<ApiResult> {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      origin: DEN_WEB_URL || DEN_API_URL,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function apiSignIn(email: string, password: string): Promise<string | null> {
  const result = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!result.response.ok || !isRecord(result.body)) return null;
  return stringField(result.body, "token");
}

async function tokenForActor(ctx: FlowContext, actor: FixtureActor): Promise<string> {
  let token = await apiSignIn(actor.email, actor.password);
  if (!token) {
    const signup = await denApiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: actor.email, name: actor.name, password: actor.password }),
    });
    const accepted = signup.response.ok || [400, 403, 409, 422].includes(signup.response.status);
    ctx.assert(accepted, `Sign-up for ${actor.email} failed: ${signup.response.status} ${signup.text.slice(0, 240)}`);
    token = await apiSignIn(actor.email, actor.password);
  }

  ctx.assert(Boolean(token), `Could not sign in ${actor.email}.`);
  tokenByEmail.set(actor.email, token || "");
  return token || "";
}

async function fetchOrgSummaries(ctx: FlowContext, token: string): Promise<OrgSummary[]> {
  const result = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `/v1/me/orgs failed: ${result.response.status} ${result.text.slice(0, 240)}`);
  if (!isRecord(result.body)) return [];
  return arrayField(result.body, "orgs").map(parseOrgSummary).filter((entry) => entry !== null);
}

function parseOrgSummary(value: unknown): OrgSummary | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  const slug = stringField(value, "slug");
  const role = stringField(value, "role");
  if (!id || !name || !slug || !role) return null;
  return { id, name, slug, role, isActive: booleanField(value, "isActive") };
}

async function setActiveOrganization(ctx: FlowContext, token: string): Promise<void> {
  const orgId = requireStateString(state.orgId, "organization id");
  const result = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationId: orgId }),
  });
  ctx.assert(result.response.ok, `Could not set active organization: ${result.response.status} ${result.text.slice(0, 240)}`);
}

async function createFixtureOrg(ctx: FlowContext, ownerToken: string): Promise<OrgSummary> {
  const created = await denApiFetch("/v1/org", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: FIXTURE_ORG_NAME }),
  });
  ctx.assert(created.response.ok, `Could not create fixture org: ${created.response.status} ${created.text.slice(0, 240)}`);
  if (!isRecord(created.body)) throw new Error("Create organization response was not an object.");
  const organization = recordField(created.body, "organization");
  if (!organization) throw new Error("Create organization response did not include organization.");
  const id = stringField(organization, "id");
  const name = stringField(organization, "name");
  const slug = stringField(organization, "slug");
  if (!id || !name || !slug) throw new Error("Create organization response was missing id/name/slug.");
  return { id, name, slug, role: "owner", isActive: true };
}

async function findOrCreateFixtureOrg(ctx: FlowContext): Promise<OrgSummary> {
  for (const actor of ACTORS) {
    const token = await tokenForActor(ctx, actor);
    const orgs = await fetchOrgSummaries(ctx, token);
    const found = orgs.find((org) => fixtureOrgNameMatches(org.name));
    if (found) return found;
  }
  const ownerToken = await tokenForActor(ctx, OWNER);
  return createFixtureOrg(ctx, ownerToken);
}

function parseMember(value: unknown): OrgMember | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const role = stringField(value, "role");
  const user = recordField(value, "user");
  if (!id || !role || !user) return null;
  const email = stringField(user, "email");
  const name = stringField(user, "name");
  if (!email || !name) return null;
  return {
    id,
    email,
    name,
    role,
    joinedAt: optionalString(value.joinedAt),
    isOwner: booleanField(value, "isOwner"),
  };
}

function parseInvitation(value: unknown): OrgInvitation | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const email = stringField(value, "email");
  const role = stringField(value, "role");
  const status = stringField(value, "status") ?? "";
  if (!id || !email || !role) return null;
  return { id, email, role, status, inviteToken: stringField(value, "inviteToken") };
}

function parseRole(value: unknown): OrgRole | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const role = stringField(value, "role");
  if (!id || !role) return null;
  return { id, role, protected: booleanField(value, "protected") };
}

function parseOrgContext(ctx: FlowContext, value: unknown): OrgContext {
  ctx.assert(isRecord(value), "Organization context response was not an object.");
  if (!isRecord(value)) throw new Error("Organization context response was not an object.");

  const organization = recordField(value, "organization");
  const currentMember = recordField(value, "currentMember");
  ctx.assert(Boolean(organization && currentMember), "Organization context was missing organization or currentMember.");
  if (!organization || !currentMember) throw new Error("Organization context was incomplete.");

  const id = stringField(organization, "id");
  const name = stringField(organization, "name");
  const slug = stringField(organization, "slug");
  const currentId = stringField(currentMember, "id");
  const currentRole = stringField(currentMember, "role");
  ctx.assert(Boolean(id && name && slug && currentId && currentRole), "Organization context was missing required strings.");
  if (!id || !name || !slug || !currentId || !currentRole) throw new Error("Organization context was missing required strings.");

  const owner = recordField(organization, "owner");
  return {
    organization: {
      id,
      name,
      slug,
      ownerEmail: owner ? stringField(owner, "email") : null,
    },
    currentMember: {
      id: currentId,
      role: currentRole,
      isOwner: booleanField(currentMember, "isOwner"),
    },
    members: arrayField(value, "members").map(parseMember).filter((entry) => entry !== null),
    invitations: arrayField(value, "invitations").map(parseInvitation).filter((entry) => entry !== null),
    roles: arrayField(value, "roles").map(parseRole).filter((entry) => entry !== null),
  };
}

async function fetchOrgContext(ctx: FlowContext, token: string): Promise<OrgContext> {
  await setActiveOrganization(ctx, token);
  const result = await denApiFetch("/v1/org", {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `/v1/org failed: ${result.response.status} ${result.text.slice(0, 240)}`);
  const parsed = parseOrgContext(ctx, result.body);
  rememberFixtureMembers(parsed);
  return parsed;
}

function rememberFixtureMembers(context: OrgContext): void {
  state.orgId = context.organization.id;
  state.orgSlug = context.organization.slug;
  for (const member of context.members) {
    if (member.email.toLowerCase() === OWNER.email.toLowerCase()) state.ownerMemberId = member.id;
    if (member.email.toLowerCase() === ADMIN.email.toLowerCase()) state.adminMemberId = member.id;
    if (member.email.toLowerCase() === MEMBER.email.toLowerCase()) state.memberMemberId = member.id;
    if (member.email.toLowerCase() === SECOND_ADMIN.email.toLowerCase()) state.secondAdminMemberId = member.id;
  }
}

function findMemberByEmail(context: OrgContext, email: string): OrgMember | null {
  const normalized = email.toLowerCase();
  return context.members.find((member) => member.email.toLowerCase() === normalized) ?? null;
}

async function ensureActorMembership(ctx: FlowContext, managerToken: string, actor: FixtureActor, role: string): Promise<OrgMember> {
  await tokenForActor(ctx, actor);
  let context = await fetchOrgContext(ctx, managerToken);
  const existing = findMemberByEmail(context, actor.email);
  if (existing) return existing;

  const pending = context.invitations.find((invitation) => invitation.email.toLowerCase() === actor.email.toLowerCase() && invitation.inviteToken);
  const inviteToken = pending?.inviteToken ?? await createInvitation(ctx, managerToken, actor.email, role);
  const actorToken = await tokenForActor(ctx, actor);
  const accepted = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${actorToken}` },
    body: JSON.stringify({ id: inviteToken }),
  });
  ctx.assert(accepted.response.ok, `Invitation accept for ${actor.email} failed: ${accepted.response.status} ${accepted.text.slice(0, 240)}`);

  context = await fetchOrgContext(ctx, managerToken);
  const member = findMemberByEmail(context, actor.email);
  ctx.assert(Boolean(member), `${actor.email} did not appear as a member after accepting the invite.`);
  if (!member) throw new Error(`${actor.email} did not join the fixture organization.`);
  return member;
}

async function createInvitation(ctx: FlowContext, managerToken: string, email: string, role: string): Promise<string> {
  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ email, role }),
  });
  ctx.assert(invite.response.ok, `Invitation for ${email} failed: ${invite.response.status} ${invite.text.slice(0, 240)}`);
  ctx.assert(isRecord(invite.body), "Invitation response was not an object.");
  if (!isRecord(invite.body)) throw new Error("Invitation response was not an object.");
  const token = stringField(invite.body, "inviteToken");
  ctx.assert(Boolean(token), "Invitation response did not include inviteToken.");
  if (!token) throw new Error("Invitation response did not include inviteToken.");
  return token;
}

async function updateMemberRoleApi(ctx: FlowContext, token: string, memberId: string, role: string): Promise<ApiResult> {
  const result = await denApiFetch(`/v1/members/${encodeURIComponent(memberId)}/role`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  });
  return result;
}

async function updateMemberRoleExpectOk(ctx: FlowContext, token: string, memberId: string, role: string): Promise<void> {
  const result = await updateMemberRoleApi(ctx, token, memberId, role);
  ctx.assert(result.response.ok, `Could not update ${memberId} to ${role}: ${result.response.status} ${result.text.slice(0, 240)}`);
}

async function deleteMemberApi(ctx: FlowContext, token: string, memberId: string): Promise<ApiResult> {
  return denApiFetch(`/v1/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function transferOwnershipApi(ctx: FlowContext, token: string, memberId: string): Promise<ApiResult> {
  return denApiFetch(`/v1/members/${encodeURIComponent(memberId)}/transfer-ownership`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
}

async function patchOrganizationName(ctx: FlowContext, token: string, name: string): Promise<ApiResult> {
  await setActiveOrganization(ctx, token);
  return denApiFetch("/v1/org", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

async function ensureFixtureOwner(ctx: FlowContext): Promise<string> {
  const probeToken = await tokenForActor(ctx, OWNER);
  let context = await fetchOrgContext(ctx, probeToken);
  let ownerEmail = context.organization.ownerEmail;
  ctx.assert(Boolean(ownerEmail), "Fixture organization did not report an owner email.");
  if (!ownerEmail) throw new Error("Fixture organization did not report an owner email.");

  if (ownerEmail.toLowerCase() === OWNER.email.toLowerCase()) return probeToken;

  const currentOwner = actorForEmail(ownerEmail);
  ctx.assert(Boolean(currentOwner), `Fixture owner ${ownerEmail} is not one of the eval actors; refusing to mutate it.`);
  if (!currentOwner) throw new Error(`Unknown fixture owner ${ownerEmail}.`);
  const currentOwnerToken = await tokenForActor(ctx, currentOwner);

  let originalOwnerMember = findMemberByEmail(await fetchOrgContext(ctx, currentOwnerToken), OWNER.email);
  if (!originalOwnerMember) {
    originalOwnerMember = await ensureActorMembership(ctx, currentOwnerToken, OWNER, "super-admin");
  }
  if (!originalOwnerMember.isOwner && !roleIncludes(originalOwnerMember.role, "super-admin")) {
    await updateMemberRoleExpectOk(ctx, currentOwnerToken, originalOwnerMember.id, "super-admin");
  }

  const transfer = await transferOwnershipApi(ctx, currentOwnerToken, originalOwnerMember.id);
  ctx.assert(transfer.response.ok, `Could not restore ${OWNER.email} as owner: ${transfer.response.status} ${transfer.text.slice(0, 240)}`);

  const restoredOwnerToken = await tokenForActor(ctx, OWNER);
  context = await fetchOrgContext(ctx, restoredOwnerToken);
  ownerEmail = context.organization.ownerEmail;
  ctx.assert(ownerEmail?.toLowerCase() === OWNER.email.toLowerCase(), `Owner restore did not stick; owner is ${ownerEmail ?? "unknown"}.`);
  return restoredOwnerToken;
}

async function resetBaseRoles(ctx: FlowContext, ownerToken: string): Promise<void> {
  let context = await fetchOrgContext(ctx, ownerToken);
  const targets: { actor: FixtureActor; role: string }[] = [
    { actor: ADMIN, role: "admin" },
    { actor: SECOND_ADMIN, role: "admin" },
    { actor: MEMBER, role: "member" },
  ];
  for (const target of targets) {
    const member = findMemberByEmail(context, target.actor.email);
    ctx.assert(Boolean(member), `${target.actor.email} is missing from the fixture organization.`);
    if (member && !member.isOwner && member.role !== target.role) {
      await updateMemberRoleExpectOk(ctx, ownerToken, member.id, target.role);
      context = await fetchOrgContext(ctx, ownerToken);
    }
  }
  state.promoted = false;
}

async function ensureFixturePrepared(ctx: FlowContext): Promise<void> {
  if (state.prepared) return;

  for (const actor of ACTORS) {
    await tokenForActor(ctx, actor);
  }

  const org = await findOrCreateFixtureOrg(ctx);
  state.orgId = org.id;
  state.orgSlug = org.slug;
  state.orgNameBeforeMutation = org.name;

  let ownerToken = await ensureFixtureOwner(ctx);
  for (const target of [ADMIN, SECOND_ADMIN, MEMBER]) {
    await ensureActorMembership(ctx, ownerToken, target, target === MEMBER ? "member" : "admin");
  }

  ownerToken = await ensureFixtureOwner(ctx);
  await resetBaseRoles(ctx, ownerToken);
  const context = await fetchOrgContext(ctx, ownerToken);
  const counts = roleCounts(context.members);
  ctx.assert(counts.owners === 1, `Fixture must start with one owner, saw ${counts.owners}.`);
  ctx.output("cloud-super-admins-fixture", JSON.stringify({ org: context.organization, members: summarizeMembers(context.members) }, null, 2));
  state.prepared = true;
}

async function ensurePromotedRoles(ctx: FlowContext): Promise<void> {
  if (state.promoted) return;
  const ownerToken = await tokenForActor(ctx, OWNER);
  await setActiveOrganization(ctx, ownerToken);
  const context = await fetchOrgContext(ctx, ownerToken);
  const admin = findMemberByEmail(context, ADMIN.email);
  const member = findMemberByEmail(context, MEMBER.email);
  ctx.assert(Boolean(admin && member), "Cannot promote fixture roles; admin or member is missing.");
  if (!admin || !member) throw new Error("Cannot promote fixture roles.");
  if (!roleIncludes(admin.role, "super-admin")) await updateMemberRoleExpectOk(ctx, ownerToken, admin.id, "super-admin");
  if (!roleIncludes(member.role, "super-admin")) await updateMemberRoleExpectOk(ctx, ownerToken, member.id, "super-admin");
  state.promoted = true;
}

async function restoreFixtureState(ctx: FlowContext): Promise<void> {
  if (!state.orgId) return;
  const adminToken = await tokenForActor(ctx, ADMIN);
  let context = await fetchOrgContext(ctx, adminToken);
  if (context.organization.ownerEmail?.toLowerCase() !== OWNER.email.toLowerCase()) {
    const originalOwner = findMemberByEmail(context, OWNER.email);
    ctx.assert(Boolean(originalOwner), "Original owner is missing during cleanup.");
    if (!originalOwner) throw new Error("Original owner is missing during cleanup.");
    if (!roleIncludes(originalOwner.role, "super-admin")) {
      await updateMemberRoleExpectOk(ctx, adminToken, originalOwner.id, "super-admin");
    }
    const transferBack = await transferOwnershipApi(ctx, adminToken, originalOwner.id);
    ctx.assert(transferBack.response.ok, `Cleanup ownership transfer failed: ${transferBack.response.status} ${transferBack.text.slice(0, 240)}`);
  }

  const ownerToken = await tokenForActor(ctx, OWNER);
  await resetBaseRoles(ctx, ownerToken);
  const restoredName = await patchOrganizationName(ctx, ownerToken, FIXTURE_ORG_NAME);
  ctx.assert(restoredName.response.ok, `Cleanup organization name restore failed: ${restoredName.response.status} ${restoredName.text.slice(0, 240)}`);
  context = await fetchOrgContext(ctx, ownerToken);
  ctx.output("cloud-super-admins-cleanup", JSON.stringify({ org: context.organization, members: summarizeMembers(context.members) }, null, 2));
}

function roleIncludes(roleValue: string, role: string): boolean {
  return roleValue.split(",").map((entry) => entry.trim().toLowerCase()).includes(role.toLowerCase());
}

function roleCounts(members: OrgMember[]): RoleCounts {
  return {
    owners: members.filter((member) => member.isOwner).length,
    superAdmins: members.filter((member) => !member.isOwner && roleIncludes(member.role, "super-admin")).length,
    admins: members.filter((member) => !member.isOwner && !roleIncludes(member.role, "super-admin") && roleIncludes(member.role, "admin")).length,
    members: members.filter((member) => !member.isOwner && !roleIncludes(member.role, "super-admin") && !roleIncludes(member.role, "admin")).length,
  };
}

function summarizeMembers(members: OrgMember[]): JsonObject[] {
  return members.map((member) => ({
    email: member.email,
    name: member.name,
    role: member.role,
    isOwner: member.isOwner,
    joined: Boolean(member.joinedAt),
  }));
}

async function navigateToAbsolute(ctx: FlowContext, url: string): Promise<void> {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

async function goToDenWeb(ctx: FlowContext, pathname: string): Promise<void> {
  await navigateToAbsolute(ctx, `${DEN_WEB_URL}${pathname}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function clearDenWebSession(ctx: FlowContext): Promise<void> {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
  if (ctx.client) await ctx.client.send("Network.clearBrowserCookies", {});
}

async function signInToDenWebWithOrg(ctx: FlowContext, email: string, password: string): Promise<void> {
  await clearDenWebSession(ctx);
  await goToDenWeb(ctx, "/");
  const signedIn = await ctx.eval(
    `fetch('/api/den/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
    }).then(async (response) => ({ ok: response.ok, status: response.status, text: (await response.text()).slice(0, 300) }))`,
    { awaitPromise: true },
  );
  ctx.assert(isRecord(signedIn) && signedIn.ok === true, `Could not sign in ${email}: ${JSON.stringify(signedIn)}`);
  await waitForDenWebSession(ctx, email);
  await setDenWebActiveOrganization(ctx);
  await goToDenWeb(ctx, "/dashboard");
  await waitForDashboardNav(ctx);
}

async function waitForDenWebSession(ctx: FlowContext, email: string): Promise<void> {
  const normalized = email.toLowerCase();
  await ctx.waitFor(
    `fetch('/api/den/api/auth/get-session', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => (payload?.user?.email ?? '').toLowerCase() === ${JSON.stringify(normalized)})
      .catch(() => false)`,
    { timeoutMs: 45_000, label: `den-web session for ${email}` },
  );
}

async function setDenWebActiveOrganization(ctx: FlowContext): Promise<void> {
  const orgId = requireStateString(state.orgId, "organization id");
  await ctx.waitFor(
    `fetch('/api/den/v1/me/active-organization', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: ${JSON.stringify(orgId)} }),
    }).then((response) => response.ok).catch(() => false)`,
    { timeoutMs: 30_000, label: "switch den-web active organization" },
  );
}

async function waitForDashboardNav(ctx: FlowContext): Promise<void> {
  await ctx.waitFor("Boolean(document.querySelector('nav')?.innerText.includes('Dashboard'))", { timeoutMs: 30_000, label: "dashboard nav" });
}

async function clickExactText(ctx: FlowContext, text: string, selector: string): Promise<void> {
  await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
}

async function clickLastExactText(ctx: FlowContext, text: string, selector: string): Promise<void> {
  await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
}

async function expectPageText(ctx: FlowContext, texts: string[]): Promise<void> {
  for (const text of texts) {
    await ctx.expectText(text, { timeoutMs: 30_000 });
  }
}

async function getNavText(ctx: FlowContext): Promise<string> {
  const value = await ctx.eval("document.querySelector('nav')?.innerText ?? ''");
  return typeof value === "string" ? value : "";
}

async function visibleSidebarChildren(ctx: FlowContext): Promise<string[]> {
  const value = await ctx.eval(`(() => {
    const groups = [...document.querySelectorAll('nav .border-l')];
    const active = groups[0];
    return active ? [...active.querySelectorAll('a')].map((element) => (element.textContent ?? '').replace(/\\s+/g, ' ').trim().replace(/\\s*Beta$/, '')) : [];
  })()`);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function assertStringListIncludes(ctx: FlowContext, actual: string[], expected: string[], label: string): void {
  for (const item of expected) {
    ctx.assert(actual.includes(item), `${label} missing ${item}; saw ${JSON.stringify(actual)}.`);
  }
}

async function visitSettingsReadOnlyPages(ctx: FlowContext): Promise<void> {
  const routes: { path: string; text: string; requiresDisabledControl: boolean }[] = [
    { path: "/dashboard/org-settings", text: "Admins can view settings here. Owners and super-admins can change them.", requiresDisabledControl: true },
    { path: "/dashboard/diagnostics", text: "Read-only: admins can view diagnostics. Owners and super-admins can run checks or change the token.", requiresDisabledControl: true },
    { path: "/dashboard/brand-appearance", text: "Admins can view brand appearance. Owners and super-admins can change it.", requiresDisabledControl: true },
    { path: "/dashboard/desktop-policies", text: "Desktop policies", requiresDisabledControl: true },
    { path: "/dashboard/billing", text: "Admins can view Stripe settings here. Owners and super-admins can open billing portals or start Settings checkouts.", requiresDisabledControl: false },
    { path: "/dashboard/api-keys", text: "Read-only: owners and super-admins can create or delete API keys.", requiresDisabledControl: true },
    { path: "/dashboard/sso", text: "Read-only: owners and super-admins can create, edit, delete, or verify SSO connections.", requiresDisabledControl: true },
    { path: "/dashboard/scim", text: "Read-only: owners and super-admins can create tokens, reconcile, change mappings, or delete SCIM connections.", requiresDisabledControl: true },
  ];
  for (const route of routes) {
    await goToDenWeb(ctx, route.path);
    await ctx.expectText(route.text, { timeoutMs: 30_000 });
    if (!route.requiresDisabledControl) continue;
    const disabled = await hasRepresentativeDisabledMutator(ctx);
    ctx.assert(disabled, `${route.path} should expose a disabled mutating control for admins.`);
  }
}

async function hasRepresentativeDisabledMutator(ctx: FlowContext): Promise<boolean> {
  const value = await ctx.eval(`(() => {
    const labels = ['Save settings', 'Run egress diagnostic', 'Save brand appearance', 'New policy', 'New key', 'Save SSO connection', 'Enable team sync', 'Reconcile now'];
    const controls = [...document.querySelectorAll('button, a')];
    return controls.some((control) => labels.some((label) => (control.textContent ?? '').includes(label)) && (control.disabled || control.getAttribute('aria-disabled') === 'true' || control.tagName === 'A'));
  })()`);
  return value === true;
}

type GeneralSettingsControlState = {
  nameInputDisabled: boolean;
  saveButtonDisabled: boolean;
};

async function readGeneralSettingsControlState(ctx: FlowContext): Promise<GeneralSettingsControlState> {
  const value = await ctx.eval(`(() => {
    const nameInput = [...document.querySelectorAll('input')].find((input) => input.closest('label')?.textContent?.includes('Name'));
    const save = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Save settings');
    return { nameInputDisabled: Boolean(nameInput?.disabled), saveButtonDisabled: Boolean(save?.disabled) };
  })()`);
  return {
    nameInputDisabled: isRecord(value) && value.nameInputDisabled === true,
    saveButtonDisabled: isRecord(value) && value.saveButtonDisabled === true,
  };
}

async function visitSuperAdminSettingsPages(ctx: FlowContext): Promise<void> {
  const routes: { path: string; text: string }[] = [
    { path: "/dashboard/brand-appearance", text: "Save brand appearance" },
    { path: "/dashboard/desktop-policies", text: "New policy" },
    { path: "/dashboard/billing", text: "Stripe" },
    { path: "/dashboard/custom-llm-providers", text: "LLM Providers" },
    { path: "/dashboard/api-keys", text: "New key" },
    { path: "/dashboard/sso", text: "Save SSO connection" },
    { path: "/dashboard/scim", text: "SCIM" },
  ];
  for (const route of routes) {
    await goToDenWeb(ctx, route.path);
    await ctx.expectText(route.text, { timeoutMs: 30_000 });
  }
}

async function openMembersTab(ctx: FlowContext): Promise<void> {
  await goToDenWeb(ctx, "/dashboard/members");
  await ctx.waitFor("document.body.innerText.includes('Invite teammates, adjust roles, and keep access clean.')", { timeoutMs: 30_000, label: "members screen" });
}

async function openRolesTab(ctx: FlowContext): Promise<void> {
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim().startsWith('Roles'));
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: "open roles tab" });
  await ctx.waitFor("document.body.innerText.includes('Default roles') || document.body.innerText.includes('Role definitions')", { timeoutMs: 20_000, label: "roles tab" });
}

async function memberActionButtonVisible(ctx: FlowContext, email: string): Promise<boolean> {
  const actorName = actorForEmail(email)?.name ?? email;
  const value = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(`button[aria-label="Open actions for ${actorName}"]`)}))`);
  return value === true;
}

async function openMemberActions(ctx: FlowContext, email: string): Promise<void> {
  const actorName = actorForEmail(email)?.name ?? email;
  await ctx.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="Open actions for ${actorName}"]`)});
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: `open member actions for ${email}` });
  await ctx.waitFor("document.body.innerText.includes('Remove member') || document.body.innerText.includes('Edit role') || document.body.innerText.includes('Transfer ownership')", { timeoutMs: 10_000, label: "member action menu" });
}

async function openMemberRoleEditor(ctx: FlowContext, email: string): Promise<void> {
  await openMemberActions(ctx, email);
  await clickExactText(ctx, "Edit role", "button");
  await ctx.waitFor("document.body.innerText.includes('Save member')", { timeoutMs: 20_000, label: "member role editor" });
}

async function setMemberRoleInUi(ctx: FlowContext, email: string, role: string): Promise<void> {
  await openMembersTab(ctx);
  await openMemberRoleEditor(ctx, email);
  const roleLabel = role.split(/[-_\s]+/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
  await ctx.waitFor(`(() => {
    const save = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Save member');
    const trigger = save?.closest('form')?.querySelector('button[aria-haspopup="listbox"]');
    trigger?.click();
    return Boolean(trigger);
  })()`, { timeoutMs: 20_000, label: "open member role select" });
  await ctx.waitFor(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')].find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(roleLabel)});
    option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return Boolean(option);
  })()`, { timeoutMs: 20_000, label: `choose role ${roleLabel}` });
  await clickExactText(ctx, "Save member", "button");
  const actorName = actorForEmail(email)?.name ?? email;
  await ctx.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="Open actions for ${actorName}"]`)});
    let row = button?.parentElement ?? null;
    for (let index = 0; index < 8 && row; index += 1) {
      const text = row.textContent ?? '';
      const actionCount = row.querySelectorAll('button[aria-label^="Open actions for"]').length;
      if (actionCount === 1 && text.includes(${JSON.stringify(roleLabel)})) return !document.body.innerText.includes('Save member');
      row = row.parentElement;
    }
    return false;
  })()`, { timeoutMs: 30_000, label: `role ${role} saved for ${email}` });
}

async function updateOrganizationNameInUi(ctx: FlowContext, name: string): Promise<void> {
  const filled = await ctx.eval(`(() => {
    const input = [...document.querySelectorAll('input')].find((candidate) => candidate.closest('label')?.textContent?.includes('Name'));
    if (!input || input.disabled) return false;
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    descriptor?.set?.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  ctx.assert(filled === true, "Could not fill enabled organization name input as super-admin.");
  await clickExactText(ctx, "Save settings", "button");
  await ctx.waitFor("document.body.innerText.includes('Workspace settings updated.')", { timeoutMs: 30_000, label: "settings mutation success" });
}

async function currentOrganizationName(ctx: FlowContext, email: string): Promise<string> {
  const actor = actorForEmail(email);
  if (!actor) throw new Error(`No fixture actor for ${email}.`);
  const token = await tokenForActor(ctx, actor);
  const context = await fetchOrgContext(ctx, token);
  return context.organization.name;
}

type RoleEditorState = {
  visible: boolean;
  canSave: boolean;
  options: string[];
};

async function readRoleEditorState(ctx: FlowContext): Promise<RoleEditorState> {
  await ctx.waitFor(`(() => {
    const save = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Save member');
    const trigger = save?.closest('form')?.querySelector('button[aria-haspopup="listbox"]');
    if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
    return Boolean(trigger);
  })()`, { timeoutMs: 20_000, label: "open role editor options" });
  await ctx.waitFor("Boolean(document.querySelector('[role=\"listbox\"]'))", { timeoutMs: 10_000, label: "role editor options" });
  const value = await ctx.eval(`(() => {
    const save = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Save member');
    const trigger = save?.closest('form')?.querySelector('button[aria-haspopup="listbox"]');
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => (option.textContent ?? '').trim().toLowerCase().replace(/\\s+/g, '-'));
    return { visible: Boolean(trigger && save), canSave: Boolean(save && !save.disabled), options };
  })()`);
  return {
    visible: isRecord(value) && value.visible === true,
    canSave: isRecord(value) && value.canSave === true,
    options: isRecord(value) && Array.isArray(value.options) ? value.options.filter((entry) => typeof entry === "string") : [],
  };
}

async function scrollMemberIntoView(ctx: FlowContext, email: string): Promise<void> {
  await ctx.waitFor(`(() => {
    const rows = [...document.querySelectorAll('div')].filter((element) => (element.textContent ?? '').includes(${JSON.stringify(email)}));
    const row = rows.find((element) => (element.textContent ?? '').includes('Locked') || (element.textContent ?? '').includes('Owner'));
    row?.scrollIntoView({ block: 'center' });
    return Boolean(row);
  })()`, { timeoutMs: 20_000, label: `scroll member ${email}` });
  await sleep(300);
}

async function transferOwnershipInUi(ctx: FlowContext, email: string): Promise<void> {
  await ctx.eval("(() => { window.confirm = () => true; return true; })()");
  await openMemberActions(ctx, email);
  await clickExactText(ctx, "Transfer ownership", "button");
  await sleep(500);
  const newOwnerToken = await tokenForActor(ctx, ADMIN);
  const context = await fetchOrgContext(ctx, newOwnerToken);
  ctx.assert(context.organization.ownerEmail?.toLowerCase() === email.toLowerCase(), `Ownership transfer did not persist; owner is ${context.organization.ownerEmail ?? "unknown"}.`);
  await signInToDenWebWithOrg(ctx, ADMIN.email, ADMIN.password);
  await openMembersTab(ctx);
  await ctx.waitFor(`(() => {
    const body = document.body.innerText;
    return body.includes(${JSON.stringify(ADMIN.name)}) && body.includes('Owner') && body.includes(${JSON.stringify(OWNER.name)}) && body.includes('Super Admin');
  })()`, { timeoutMs: 45_000, label: "ownership transfer visible" });
}
