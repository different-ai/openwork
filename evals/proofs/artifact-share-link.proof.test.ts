import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { artifactShareLinkWorld } from "../worlds/artifact-share-link.ts";

const test = spec.world(artifactShareLinkWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});

const WITHIN = 60_000;
const SIGN_IN = "Sign in to open this artifact";
const API_SIGN_IN = "Sign in to OpenWork to open this artifact.";
const NO_ACCESS = "You don't have access to this artifact. Ask the person who sent you the link to share it with you.";
const LINK_HEADING = "Link for your organization";
const ITEM = "Standing desk";

test("an owner shares a live artifact by link and only a teammate with access opens it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.app);
  const before = user.on(world.web);
  const inApp = { resourceUri: world.resourceUri };
  const inBrowser = { frameTitle: "Artifact" };
  const shareLink = { role: "heading", label: LINK_HEADING } satisfies Parameters<typeof owner.see>[0];
  const authHeading = { role: "heading", label: SIGN_IN } satisfies Parameters<typeof owner.see>[0];
  let copiedLink = "";
  let teammateSurface: Awaited<ReturnType<typeof world.freshBrowser>>;

  async function openArtifact() {
    await owner.see({ role: "button", label: "Artifacts" }, { timeoutMs: WITHIN });
    await owner.click({ role: "button", label: "Artifacts" });
    await owner.see({ role: "button", label: `Open ${world.title}` }, { timeoutMs: WITHIN });
    await owner.click({ role: "button", label: `Open ${world.title}` });
  }

  async function openShare() {
    await owner.see({ role: "button", label: "Share" }, { timeoutMs: WITHIN });
    await owner.click({ role: "button", label: "Share" });
    await owner.see({ role: "dialog", label: `Share ${world.title}` });
    await owner.click({ role: "tab", label: "Within your organization" });
  }

  async function signIn(browser: typeof owner, person: { email: string; password: string }) {
    const email = { role: "textbox", label: "Email" } satisfies Parameters<typeof owner.see>[0];
    const password = { role: "textbox", label: "Password" } satisfies Parameters<typeof owner.see>[0];
    await browser.see(email, { timeoutMs: WITHIN });
    await browser.type(email, person.email);
    await browser.click({ role: "button", label: "Next" });
    await browser.see(password, { timeoutMs: WITHIN });
    await browser.type(password, person.password, { sensitive: true });
    await browser.click({ role: "button", label: "Sign in" });
  }

  async function screenshotAtBothWidths(browser: typeof owner) {
    await browser.screenshot();
    await browser.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await browser.screenshot();
    await browser.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  }

  async function seeRefusal(browser: typeof owner, surface: typeof world.web) {
    await browser.see({ role: "status", label: NO_ACCESS }, { timeoutMs: WITHIN });
    const page = probe.on(surface);
    const frames = await page.dom("iframe[title='Artifact'][srcdoc]");
    const text = (await page.text()).trim();
    expect(text).toContain(NO_ACCESS);
    expect(frames.elements).toHaveLength(0);
    return { text, refused: text.includes(NO_ACCESS) && frames.elements.length === 0 };
  }

  await step("before: the owner has no organization link in Share", async () => {
    await openArtifact();
    await openShare();
    await owner.notSee(shareLink);
    await owner.notSee({ role: "button", label: "Copy link" });
    const text = await probe.on(world.app).text();
    await owner.screenshot();
    evidence.recordAssertionEvidence("No organization link", "The organization tab offers neither an organization link nor a Copy link button.", !text.includes(LINK_HEADING));
  });

  await step("before: a signed-in teammate cannot open the artifact at its browser address", async () => {
    await before.navigate(world.artifactUrl);
    await signIn(before, world.teammate);
    await probe.eventually(() => world.currentUrl(world.web), { within: WITHIN, until: (url) => url === world.memberUrl });
    await before.navigate(world.memberUrl);
    const refusal = await seeRefusal(before, world.web);
    await before.screenshot();
    evidence.recordAssertionEvidence("Even a teammate with access is refused when the feature is off", refusal.text, refusal.refused);
  });

  await step("the owner saves an equipment request in the artifact", async () => {
    await owner.press("Escape");
    await owner.see({ role: "status", label: /^0\s*requests · updated/u, mcpApp: inApp }, { timeoutMs: WITHIN });
    await owner.type({ role: "textbox", label: "Item", mcpApp: inApp }, ITEM);
    await owner.click({ role: "button", label: "Add request", mcpApp: inApp });
    await owner.see({ role: "status", label: /^1\s*request · updated/u, mcpApp: inApp }, { timeoutMs: WITHIN });
    await owner.see({ role: "button", label: `Delete ${ITEM}`, mcpApp: inApp });
    await owner.screenshot();
    const frames = await probe.on(world.app).dom("[data-mcp-app-resource] > iframe");
    expect(frames.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The owner added a row to a previously empty artifact", `The open artifact now shows one request: ${ITEM}.`, frames.elements.length === 1);
  });

  await step("after: the owner copies an organization link from Share", async () => {
    await world.setFeatures(true);
    await owner.reload();
    await openArtifact();
    await openShare();
    await owner.see(shareLink, { timeoutMs: WITHIN });
    await owner.see({ text: world.artifactUrl }, { text: world.artifactUrl });
    const text = await probe.on(world.app).text();
    copiedLink = text.match(/https?:\/\/[^\s]+\/artifact\?[^\s]+/u)?.[0] ?? "";
    const url = new URL(copiedLink);
    expect(url.origin).toBe(world.webOrigin);
    expect(url.pathname).toBe("/artifact");
    expect(url.searchParams.get("id")).toBe(world.appId);
    expect(url.searchParams.get("org")).toBe(world.organizationId);
    await owner.see({ role: "button", label: "Open in browser" });
    await owner.click({ role: "button", label: "Copy link" });
    await owner.see({ role: "status", label: "Link copied." });
    await owner.screenshot();
    const copied = (await probe.on(world.app).text()).includes("Link copied.");
    expect(copied).toBe(true);
    evidence.recordAssertionEvidence("The link identifies this artifact and organization", `${url.href} · Link copied.`, copied && url.href === world.artifactUrl);
  });

  await step("a signed-out teammate opens the link and is asked to sign in there", async () => {
    teammateSurface = await world.freshBrowser();
    const teammate = user.on(teammateSurface);
    await teammate.navigate(copiedLink);
    await teammate.see(authHeading, { timeoutMs: WITHIN });
    const currentUrl = await world.currentUrl(teammateSurface);
    const cookie = await world.sessionCookie(teammateSurface);
    expect(currentUrl).toBe(copiedLink);
    expect(cookie).toBeNull();
    await screenshotAtBothWidths(teammate);
    evidence.recordAssertionEvidence("Den web keeps the signed-out visitor on the artifact link", `The browser has no session cookie and shows “${SIGN_IN}”.`, currentUrl === copiedLink && cookie === null);
  });

  await step("after: the teammate signs in and sees the owner's saved request in the browser artifact", async () => {
    const teammate = user.on(teammateSurface);
    await signIn(teammate, world.teammate);
    await probe.eventually(() => world.currentUrl(teammateSurface), { within: WITHIN, until: (url) => url === world.memberUrl });
    await teammate.see({ role: "status", label: /^1\s*request · updated/u, mcpApp: inBrowser }, { timeoutMs: WITHIN });
    await teammate.see({ role: "button", label: `Delete ${ITEM}`, mcpApp: inBrowser });
    const cookie = await world.sessionCookie(teammateSurface);
    expect(cookie).toMatchObject({ domain: new URL(world.apiOrigin).hostname, path: "/", httpOnly: true });
    await teammate.screenshot();
    evidence.recordAssertionEvidence("The API-origin artifact loads live data after sign-in", `${world.memberUrl} shows ${ITEM} inside the artifact frame. Session attributes: ${JSON.stringify(cookie)}.`, cookie?.httpOnly === true);
  });

  await step("a signed-in organization member without a share cannot open the artifact", async () => {
    const surface = await world.freshBrowser();
    const outsider = user.on(surface);
    await outsider.navigate(new URL("/", world.webOrigin).href);
    await signIn(outsider, world.outsider);
    await probe.eventually(() => world.sessionCookie(surface), { within: WITHIN, until: (cookie) => cookie !== null });
    await outsider.navigate(copiedLink);
    const refusal = await seeRefusal(outsider, surface);
    expect(await world.currentUrl(surface)).toBe(world.memberUrl);
    await screenshotAtBothWidths(outsider);
    evidence.recordAssertionEvidence("The link gives no access by itself", refusal.text, refusal.refused);
  });

  await step("a signed-out visitor at the API address gets a sign-in link back to the shared artifact", async () => {
    const surface = await world.freshBrowser();
    const anonymous = user.on(surface);
    await anonymous.navigate(world.memberUrl);
    await anonymous.see({ role: "status", label: /^Sign in to OpenWork to open this artifact\./u }, { timeoutMs: WITHIN });
    await anonymous.see({ role: "link", label: "Sign in" });
    const href = await world.signInHref(surface);
    expect(href).toBe(copiedLink);
    await screenshotAtBothWidths(anonymous);
    evidence.recordAssertionEvidence("The sign-in link leads back to the same artifact", `${API_SIGN_IN} Sign in → ${href}`, href === copiedLink);
  });

  await step("turning the feature back off closes the artifact on the teammate's next load", async () => {
    await world.setFeatures(false);
    const teammate = user.on(teammateSurface);
    await teammate.reload();
    const refusal = await seeRefusal(teammate, teammateSurface);
    await teammate.screenshot();
    evidence.recordAssertionEvidence("Turning off the feature disables the existing link", refusal.text, refusal.refused);
  });
});
