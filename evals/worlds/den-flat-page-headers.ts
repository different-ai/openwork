import { createOrg, type Seed } from "@openwork/env";
import { evaluateOnSurface, type Surface } from "@openwork/cdp";
import { enableOrganizationCapabilities } from "./dashboards.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown, key: string): string {
  const result = isRecord(value) ? value[key] : undefined;
  if (typeof result !== "string" || !result) throw new Error(`Header arrangement is missing ${key}.`);
  return result;
}

// Fixed, read-only witness: probe.dom supplies geometry but not computed type,
// contrast, clipping, or background images. Read the real rendered heading;
// never inject a title, style, product component, or feature response.
function headerMeasurements(surface: Surface) {
  return evaluateOnSurface(surface, () => {
    const header = document.querySelector<HTMLElement>("main [data-dashboard-flat-header], main [data-dashboard-hero], main header > div > div:has(> h1)");
    const heading = header?.querySelector<HTMLElement>("h1");
    const shell = header?.parentElement;
    const main = document.querySelector<HTMLElement>("main");
    if (!header || !heading || !shell || !main) throw new Error("The real dashboard heading has not rendered.");

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    if (!paint) throw new Error("Could not measure heading colors.");
    const color = (value: string) => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = value;
      paint.fillRect(0, 0, 1, 1);
      const pixels = paint.getImageData(0, 0, 1, 1).data;
      return { red: pixels[0] ?? 0, green: pixels[1] ?? 0, blue: pixels[2] ?? 0, alpha: (pixels[3] ?? 0) / 255 };
    };
    const luminance = (fill: ReturnType<typeof color>) => {
      const linear = (channel: number) => {
        const srgb = channel / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(fill.red) + 0.7152 * linear(fill.green) + 0.0722 * linear(fill.blue);
    };
    let backdrop: ReturnType<typeof color> | null = null;
    for (let parent: Element | null = heading; parent; parent = parent.parentElement) {
      const fill = color(getComputedStyle(parent).backgroundColor);
      if (fill.alpha === 1) {
        backdrop = fill;
        break;
      }
    }
    if (!backdrop) throw new Error("The heading has no measurable opaque page background.");
    const style = getComputedStyle(heading);
    const inkColor = color(style.color);
    const semanticInk = color(style.getPropertyValue("--dls-text-primary"));
    const ink = luminance(inkColor);
    const background = luminance(backdrop);
    const images = [header, ...header.querySelectorAll("*")]
      .map((element) => getComputedStyle(element).backgroundImage)
      .filter((image) => image !== "none");
    const description = shell.querySelector<HTMLElement>(":scope > p");
    const { left, right, width, height } = heading.getBoundingClientRect();
    return {
      title: heading.textContent?.trim() ?? "",
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10),
      inkLuminance: ink,
      semanticInkMatch: inkColor.red === semanticInk.red && inkColor.green === semanticInk.green
        && inkColor.blue === semanticInk.blue && inkColor.alpha === semanticInk.alpha,
      contrast: (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05),
      textOverflow: style.textOverflow,
      heading: { left, right, width, height, clientWidth: heading.clientWidth, scrollWidth: heading.scrollWidth },
      headerHeight: header.getBoundingClientRect().height,
      headerImages: images,
      canvasCount: header.querySelectorAll("canvas").length,
      flat: header.hasAttribute("data-dashboard-flat-header"),
      description: description?.textContent?.trim() ?? "",
      widths: {
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        main: { client: main.clientWidth, scroll: main.scrollWidth },
        shell: { client: shell.clientWidth, scroll: shell.scrollWidth },
      },
    };
  });
}

/** Real Members, provider, and Analytics pages, one owner, and another default-off org. */
export async function denFlatPageHeaders(seed: Seed) {
  const stamp = Date.now().toString(36);
  const names = { workspace: `Compact headers ${stamp}`, otherWorkspace: `Legacy headers ${stamp}` };
  const den = await seed.den({
    env: { DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    org: {
      name: names.workspace,
      admin: { name: "Header Owner", email: `headers-owner+${stamp}@example.test` },
      members: { member: { name: "Header Member", email: `headers-member+${stamp}@example.test` } },
    },
  });
  const initial = await seed.api(den.admin, "/v1/org");
  if (!initial.response.ok || !isRecord(initial.body)) throw new Error("Could not read the header workspace.");
  const orgId = textField(initial.body.organization, "id");
  const slug = textField(initial.body.organization, "slug");
  // The existing fixture disables plan gating, so Analytics is entitled. Enable
  // Library usage through the canonical admin seed API before any browser acts;
  // denFlatPageHeaders itself remains off until the owner uses /admin.
  await enableOrganizationCapabilities(seed, den.admin, { libraryUsage: true }, orgId);
  const otherOrg = await createOrg(den, names.otherWorkspace);

  const web = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1280, height: 900 } });
  // Leave the anonymous page first: if it observed the session installed below, it would queue the post-sign-in
  // organization picker for this tab instead of letting the arranged workspace selection stand.
  await web.client.send("Page.navigate", { url: "about:blank" });
  // Workspace switching uses Better Auth's cookie session, not the bearer token
  // seeded by signedInAs. Arrange one real server-issued owner cookie before acts.
  const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
    method: "POST", headers: { origin: den.ref.webUrl },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  const cookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
  const separator = cookie.indexOf("=");
  if (!signedIn.response.ok || separator < 1) throw new Error(`Header owner sign-in failed: HTTP ${signedIn.response.status}`);
  if (!isRecord(signedIn.body) || typeof signedIn.body.token !== "string") throw new Error("Header owner sign-in returned no session token");
  // The browser's own session, so specs can wait for a workspace switch to persist before reloading.
  const owner = { ...den.admin, token: signedIn.body.token };
  const applied = await web.client.send("Network.setCookie", {
    name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
    url: den.ref.webUrl, path: "/", httpOnly: true, secure: new URL(den.ref.webUrl).protocol === "https:",
  });
  if (!isRecord(applied) || applied.success !== true) throw new Error("Could not install the owner browser session.");
  const selected = await seed.api(den.admin, "/api/auth/organization/set-active", {
    method: "POST", headers: { cookie, origin: den.ref.webUrl }, body: JSON.stringify({ organizationId: orgId }),
  });
  if (!selected.response.ok) throw new Error(`Header workspace selection failed: HTTP ${selected.response.status}`);
  await web.client.send("Page.navigate", { url: new URL("/dashboard/members", den.ref.webUrl).toString() });

  return {
    den, web, owner, names, orgId, slug, otherOrgId: otherOrg.id,
    scope: { "x-openwork-org-id": orgId },
    measurements: () => headerMeasurements(web),
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async [Symbol.asyncDispose]() { await otherOrg[Symbol.asyncDispose](); },
  };
}

export type HeaderMeasurements = Awaited<ReturnType<typeof headerMeasurements>>;
