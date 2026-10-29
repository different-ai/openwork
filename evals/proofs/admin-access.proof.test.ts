import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminAccessWorld } from "../worlds/admin-access.ts";

const test = spec.world(adminAccessWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("visitors without platform access see a standalone access page while admins can navigate", async ({ world, user, probe, step, evidence }) => {
  await step("after: a signed-out visitor sees sign-in without the admin sidebar", async () => {
    const visitor = user.on(world.anonymous);
    await visitor.see({ role: "heading", label: "Sign in required" });
    await visitor.notSee({ testId: "admin-navigation" });
    const chrome = await probe.on(world.anonymous).dom('aside, [data-testid="admin-breadcrumb-current"], [data-testid="admin-dashboard"]');
    expect(chrome.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Signed-out visitors have no admin navigation, breadcrumbs or dashboard", `admin elements=${chrome.elements.length}`, chrome.elements.length === 0);
    await visitor.screenshot();
  });

  await step("deep links keep the same access boundary on a narrow screen", async () => {
    const visitor = user.on(world.anonymous);
    await visitor.resizeViewport({ width: 320, height: 900, deviceScaleFactor: 1 });
    await visitor.navigate(world.url("/admin/organizations/org_00000000000000000000000000/billing"));
    await visitor.see({ role: "heading", label: "Sign in required" });
    await visitor.notSee({ testId: "admin-navigation" });
    const layout = await probe.on(world.anonymous).dom("main");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("A direct organization link shows only the access page at 320 pixels", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px`, layout.documentWidth <= layout.viewportWidth);
    await visitor.screenshot();
    await visitor.click({ role: "link", label: "Open sign-in page" });
    await visitor.see({ testId: "auth-landing-form" }, { timeoutMs: 60_000 });
    expect(new URL(await probe.on(world.anonymous).url()).pathname).toBe("/");
    await visitor.notSee({ testId: "admin-navigation" });
  });

  await step("a signed-in organization member sees access denied without admin controls", async () => {
    const member = user.on(world.member);
    await member.see({ role: "heading", label: "Admin access required" });
    await member.notSee({ testId: "admin-navigation" });
    await member.notSee({ role: "heading", label: "Opportunities" });
    const result = await probe.api(world.den.members.member, "/v1/admin/features");
    expect(result.response.status).toBe(403);
    evidence.recordAssertionEvidence("Organization membership does not reveal the platform admin shell", `admin authorization=${result.response.status}; no sidebar or opportunity controls`, result.response.status === 403);
    await member.screenshot();
    await member.navigate(world.url("/admin"));
    await member.see({ role: "heading", label: "Admin access required" });
    await member.notSee({ testId: "admin-navigation" });
  });

  await step("an invalid stored session never unlocks the sidebar", async () => {
    const expired = user.on(world.expired);
    await expired.see({ role: "heading", label: "Sign in required" });
    await expired.notSee({ testId: "admin-navigation" });
    const chrome = await probe.on(world.expired).dom("aside");
    expect(chrome.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("A stored token is not treated as permission", `sidebars=${chrome.elements.length}; expired session remains signed out`, chrome.elements.length === 0);
    await expired.screenshot();
  });

  await step("a verified admin can use the sidebar and navigate between pages", async () => {
    const admin = user.on(world.admin);
    await admin.see({ testId: "admin-navigation" }, { timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: "Users" });
    await admin.click({ role: "link", label: "Organizations" });
    await admin.see({ role: "heading", label: "Organizations" });
    await admin.see({ testId: "admin-navigation" });
    const navigation = await probe.on(world.admin).dom('[data-testid="admin-nav-organizations"][aria-current="page"]');
    expect(navigation.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Password-token admins keep working navigation after authorization", `active organization links=${navigation.elements.length}`, navigation.elements.length === 1);
    await admin.screenshot();
  });

  await step("an admin signed in with only a session cookie can open the same shell", async () => {
    const admin = user.on(world.cookieAdmin);
    await admin.see({ testId: "admin-navigation" }, { timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: "Features" });
    const navigation = await probe.on(world.cookieAdmin).dom('[data-testid="admin-navigation"]');
    expect(navigation.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The access gate supports the separate cookie sign-in path", `cookie-authenticated admin navigation=${navigation.elements.length}; feature page visible`, navigation.elements.length === 1);
    await admin.screenshot();
  });
});
