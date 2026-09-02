import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/**
 * The organization's default desktop policy as Den returns it, with the shape
 * checks a spec needs before comparing saved values.
 */
export async function readDefaultDesktopPolicy(
  channel: Pick<Seed, "api">,
  admin: Parameters<Seed["api"]>[0],
): Promise<Record<string, unknown>> {
  const result = await channel.api(admin, "/v1/desktop-policies");
  const policies = isRecord(result.body) ? records(result.body.desktopPolicies) : [];
  const policy = policies.find((entry) => entry.isDefault === true);
  if (!result.response.ok || !policy || typeof policy.id !== "string") {
    throw new Error(`Reading the default desktop policy failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return policy;
}

/**
 * One organization whose default desktop policy is still Custom, a member
 * signed in to a fresh desktop, and the admin signed in to that policy's Den
 * Web editor. Only Den and the member desktop are placed; the admin browser
 * shares the Den's placement so Den Web is reached over loopback.
 */
export async function defaultPolicyEditorAndMemberDesktop(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: {
      name: `Restricted Policy ${stamp}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" } },
    },
  });
  if (!den.members.jordan) throw new Error("seed.den() did not provision the jordan member session");

  const policyBefore = await readDefaultDesktopPolicy(seed, den.admin);
  const policyId = String(policyBefore.id);
  const editorPath = `/dashboard/desktop-policies/${encodeURIComponent(policyId)}`;

  const member = await seed.desktop({ den, as: "jordan" });
  const admin = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: editorPath,
    headless: true,
    // Tall enough that the whole capability list, through the editable
    // Welcome Page row, stays inside the frame the vision judge sees.
    viewport: { width: 1440, height: 2100 },
  });

  return { den, member, admin, policyId, editorPath };
}
