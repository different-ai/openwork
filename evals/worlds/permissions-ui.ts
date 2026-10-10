import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { evaluateOnSurface, type Surface } from "@openwork/cdp";
import { setPermissionsFeature, type PermissionsCall } from "./permissions.ts";
import { readDenStickyActionBar } from "./den-sticky-action-bar.ts";

/**
 * Den Web for the Permissions screens. One organization, Permissions off:
 *   - Olivia, the owner (also the deployment's platform admin, who turns features on),
 *   - Maya, a member of the Support team,
 *   - Nora, a member in no team.
 * Each person has their own signed-in browser.
 */

const ORGANIZATION_NAME = "Permissions UI workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing from the Den response`);
  return value;
}

// probe.dom exposes geometry, not computed typography or contrast. This fixed,
// read-only CDP witness measures real rendered ink and ancestor backgrounds; it
// never changes the page, clicks a control, or matches Tailwind class names.
function permissionsTypography(surface: Surface) {
  return evaluateOnSurface(surface, () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    if (!paint) throw new Error("Could not measure permission text colors.");
    const color = (value: string) => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = value;
      paint.fillRect(0, 0, 1, 1);
      const data = paint.getImageData(0, 0, 1, 1).data;
      return { red: data[0] ?? 0, green: data[1] ?? 0, blue: data[2] ?? 0, alpha: (data[3] ?? 0) / 255 };
    };
    const luminance = (value: ReturnType<typeof color>) => {
      const linear = (channel: number) => {
        const srgb = channel / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(value.red) + 0.7152 * linear(value.green) + 0.0722 * linear(value.blue);
    };
    const read = (selector: string) => Array.from(document.querySelectorAll(selector))
      .filter((element) => element.getClientRects().length > 0 && Boolean(element.textContent?.trim()))
      .map((element) => {
        const style = getComputedStyle(element);
        const layers: ReturnType<typeof color>[] = [];
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          layers.unshift(color(getComputedStyle(ancestor).backgroundColor));
        }
        const blend = (front: ReturnType<typeof color>, back: ReturnType<typeof color>) => ({
          red: front.red * front.alpha + back.red * (1 - front.alpha),
          green: front.green * front.alpha + back.green * (1 - front.alpha),
          blue: front.blue * front.alpha + back.blue * (1 - front.alpha),
          alpha: 1,
        });
        const background = layers.reduce((back, front) => blend(front, back), { red: 255, green: 255, blue: 255, alpha: 1 });
        const ink = luminance(blend(color(style.color), background));
        const backdrop = luminance(background);
        return {
          text: element.textContent?.trim() ?? "",
          fontSize: Number.parseFloat(style.fontSize),
          fontFamily: style.fontFamily,
          textTransform: style.textTransform,
          contrast: (Math.max(ink, backdrop) + 0.05) / (Math.min(ink, backdrop) + 0.05),
        };
      });
    return {
      inactiveTabs: read('[role="tab"][aria-selected="false"]'),
      memberHeaders: read('[data-testid="members-column-header"] > span'),
      memberJoined: read('[data-testid="member-joined"]'),
      memberLocked: read('[data-testid="member-owner-locked"]'),
      memberEmails: read('[data-testid="org-member-identity"] > div:last-child > p'),
      memberBadges: read('[data-testid="org-member-identity"] > div:last-child > div > span'),
      permissionCounts: read('[data-testid="permission-set-row"] > span'),
      permissionHeadings: read('[data-testid="permission-set"] h1'),
      permissionAreaHeaders: read('[data-testid^="permission-area-"] h2'),
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
}

export async function permissionsUiWorld(seed: Seed) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Olivia Owner", email: `permissions-ui-owner+${stamp}@example.test` },
      members: {
        maya: { name: "Maya Member", email: `permissions-ui-maya+${stamp}@example.test` },
        nora: { name: "Nora Newcomer", email: `permissions-ui-nora+${stamp}@example.test` },
      },
    },
  });
  const owner = den.admin;
  const { maya, nora } = den.members;
  if (!maya || !nora) throw new Error("The testkit did not provision every member session");

  const orgs = await seed.api(owner, "/v1/me/orgs");
  const orgList = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = text(orgList.find((org) => org.name === ORGANIZATION_NAME)?.id, "organization id");
  const scope = { "x-openwork-org-id": orgId };

  const roster = await seed.api(owner, "/v1/org", { headers: scope });
  const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(isRecord) : [];
  const memberId = (session: DenSession) => text(
    members.find((member) => isRecord(member.user) && member.user.email === session.email)?.id,
    `member id for ${session.email}`,
  );
  const ids = { owner: memberId(owner), maya: memberId(maya), nora: memberId(nora) };

  const created = await seed.api(owner, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Support", memberIds: [ids.maya] }) });
  const team = isRecord(created.body) && isRecord(created.body.team) ? created.body.team : null;
  if (created.response.status !== 201 || !team) throw new Error(`Creating the Support team failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  const supportTeamId = text(team.id, "Support team id");

  const viewport = { width: 1280, height: 900 };
  const ownerWeb = await seed.web({ den, signedInAs: owner, startPath: "/dashboard", headless: true, viewport });
  const mayaWeb = await seed.web({ den, signedInAs: maya, startPath: "/dashboard", headless: true, viewport });
  const noraWeb = await seed.web({ den, signedInAs: nora, startPath: "/dashboard", headless: true, viewport });

  return {
    den,
    orgId,
    owner,
    maya,
    nora,
    ids,
    supportTeamId,
    ownerWeb,
    mayaWeb,
    noraWeb,
    typography(person: "owner" | "maya" = "owner") {
      return permissionsTypography(person === "maya" ? mayaWeb : ownerWeb);
    },
    stickyBar(switchLabel: string) {
      return readDenStickyActionBar(ownerWeb, "permissions", switchLabel);
    },
    /** Absolute Den Web URL for a dashboard path. */
    url(path: string): string {
      return new URL(path, den.ref.webUrl).toString();
    },
    /** A platform administrator turns Permissions on or off for this organization from /admin. */
    setPermissions(enabled: boolean): Promise<PermissionsCall> {
      return setPermissionsFeature(owner, orgId, enabled);
    },
    /** Request headers that pin a Den call to this organization. */
    scope,
  };
}

export type PermissionsUiWorld = Awaited<ReturnType<typeof permissionsUiWorld>>;
