import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { acmeCloudCodingRepositories, cloudCodingWorld } from "../worlds/cloud-coding.ts";

const test = spec.world(cloudCodingWorld, {
  timeout: 600_000, needs: { commands: ["pnpm"] },
  resources: { surfaces: ["web"], services: ["den"] },
});
const button = (label: string | RegExp) => ({ role: "button", label }) as const;
const heading = (label: string | RegExp) => ({ role: "heading", label }) as const;
const cloudCoding = { role: "link", label: /^Cloud coding$/ } as const;
const cloudCodingSwitch = { role: "switch", label: /^Cloud coding$/ } as const;
const overviewPath = "/v1/cloud-coding";
const dashboardPath = "/dashboard/cloud-coding";
const repoNames = acmeCloudCodingRepositories.map(fullName => expect.objectContaining({ fullName }));

test("an admin connects GitHub once and sees who has linked their account", async ({ world, user, probe, step, evidence }) => {
  const maya = user.on(world.owner);
  const page = probe.on(world.owner);

  await step("before: Cloud coding shows GitHub as not connected and explains how it works", async () => {
    await maya.see(cloudCoding, { timeoutMs: 90_000 });
    const links = (await page.dom("aside a, nav a")).elements.map(link => link.text);
    const position = links.indexOf("Cloud coding");
    expect(position).toBeGreaterThan(0);
    expect(links[position - 1]).toMatch(/^Connectors/);
    await maya.click(cloudCoding);
    await maya.see({ text: /^Not connected$/ }, { timeoutMs: 90_000 });
    await maya.see(heading(/^How it works$/));
    evidence.recordAssertionEvidence("Cloud coding starts disconnected", "Cloud coding follows Connectors in the sidebar. The page shows Not connected, Connect GitHub, and How it works.", (await page.text()).includes("Not connected"));
    await maya.screenshot();
  });

  await step("the admin chooses Connect GitHub and installs the app on GitHub's page", async () => {
    await maya.click(button(/^Connect GitHub$/));
    await maya.see(heading(/^Install & Authorize OpenWork$/));
    expect(new URL(await page.url()).origin).toBe(world.github.env.GITHUB_CLOUD_CODING_WEB_BASE);
    for (const name of acmeCloudCodingRepositories) await maya.see({ text: name });
    evidence.recordAssertionEvidence("GitHub asks the admin to authorize the installation", `Install & Authorize OpenWork lists ${acmeCloudCodingRepositories.join(", ")}.`, new URL(await page.url()).origin === world.github.env.GITHUB_CLOUD_CODING_WEB_BASE);
    await maya.screenshot();
    await maya.click(button(/^Install & Authorize$/));
  });

  await step("after: GitHub is connected with four repositories and locked push rules", async () => {
    await maya.see({ text: /^GitHub connected$/ }, { timeoutMs: 90_000 });
    await maya.see({ text: /^On for everyone, 4 repositories$/ });
    for (const name of acmeCloudCodingRepositories) await maya.see({ text: name });
    expect((await page.text()).match(/\bAlways\b/g)).toHaveLength(2);
    await maya.see({ text: /^The person who asked$/ });
    const { response, body } = await probe.api(world.maya, overviewPath);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ connection: { accountLogin: "acme" }, repositories: expect.arrayContaining(repoNames) });
    const repositories = typeof body === "object" && body !== null && "repositories" in body ? body.repositories : null;
    expect(repositories).toHaveLength(4);
    evidence.recordAssertionEvidence("Acme is connected and the rules cannot be edited", "GitHub connected · On for everyone, 4 repositories. Both push rules show Always; pull requests open as The person who asked.", response.ok);
    await maya.screenshot();
  });

  await step("after: People shows Maya linked and the other three teammates not linked yet", async () => {
    await maya.see(heading(/^Recent pull requests$/));
    await maya.wheelAt({ x: 1000, y: 800, deltaY: 850 });
    await maya.see({ text: /^No pull requests yet\./ });
    const rows = (await page.dom("tr")).elements.map(row => row.text);
    expect(rows.find(row => row.includes("Maya Chen (you)"))).toContain("maya-chen");
    for (const person of ["Arjun Patel", "Leo Martin", "Sam Rivera"]) {
      const row = rows.find(text => text.includes(person));
      expect(row).toContain("Not linked yet");
      expect(row).toContain("Send link");
    }
    evidence.recordAssertionEvidence("People shows whose GitHub account is linked", "Maya Chen (you) is linked as maya-chen. Arjun, Leo, and Sam show Not linked yet and Send link. Recent pull requests is empty.", rows.some(row => row.includes("Maya Chen (you)") && row.includes("maya-chen")));
    await maya.screenshot();
  });

  await step("the admin sends Leo a link to connect GitHub", async () => {
    const rows = (await page.dom("tr")).elements.filter(row => row.text.includes("Send link"));
    const leo = rows.findIndex(row => row.text.includes("Leo Martin"));
    expect(leo).toBeGreaterThanOrEqual(0);
    await maya.click({ ...button(/^Send link$/), nth: leo });
    const sent = "Sent Leo a link to connect GitHub";
    await maya.see({ text: sent });
    await maya.see(button(/^Sent$/));
    const { response, body } = await probe.api(world.maya, "/v1/dev/emails");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ emails: expect.arrayContaining([expect.objectContaining({ to: "leo@acme.dev", template: "cloudCodingLinkGithub" })]) });
    evidence.recordAssertionEvidence("Leo receives his own GitHub link", `${sent}. Leo's row shows Sent, and the development outbox captured the reminder for leo@acme.dev.`, response.ok);
    await maya.screenshot();
  });

  await step("the admin chooses Sam in the Cloud coding access dialog", async () => {
    await maya.click(button(/^Change$/));
    await maya.see({ role: "dialog", label: /^Who can use Cloud coding$/ });
    await maya.click({ role: "switch", label: /^Everyone in the organization$/ });
    await maya.click(button(/^Add person$/));
    await maya.click({ role: "option", label: /Sam Rivera/ });
    await maya.click(button(/^Add Sam Rivera$/));
    await maya.see(button(/^Remove Sam Rivera$/));
    await maya.see({ text: "Off. Only the people and teams below can use it." });
    evidence.recordAssertionEvidence("The access dialog supports choosing one teammate", "Everyone in the organization is off, and only Sam Rivera is listed.", await page.has("Off. Only the people and teams below can use it."));
    await maya.screenshot();
    await maya.click(button(/^Save changes$/));
  });

  await step("after: only one person can use Cloud coding", async () => {
    await maya.see({ text: /^On for 1 person, 4 repositories$/ });
    await maya.see({ text: /^1 person$/ });
    const { body } = await probe.api(world.maya, overviewPath);
    expect(body).toMatchObject({ access: { orgWide: false }, people: expect.arrayContaining([
      expect.objectContaining({ name: "Sam Rivera", canUse: true }),
      expect.objectContaining({ name: "Leo Martin", canUse: false }),
    ]) });
    evidence.recordAssertionEvidence("The new audience is saved", "Who can use it shows 1 person. The page says On for 1 person, 4 repositories. Sam is included and Leo is not.", await page.has("On for 1 person, 4 repositories"));
    await maya.screenshot();
  });

  await step("the admin turns Cloud coding off for everyone", async () => {
    await maya.click(cloudCodingSwitch);
    await maya.see({ text: /^Off for everyone$/ });
    const { body } = await probe.eventually(() => probe.api(world.maya, overviewPath), {
      within: 10_000,
      until: ({ body }) => typeof body === "object" && body !== null && "enabled" in body && body.enabled === false,
      label: "Cloud coding is saved as off",
    });
    expect(body).toMatchObject({ enabled: false, connection: { accountLogin: "acme" } });
    evidence.recordAssertionEvidence("The organization switch turns Cloud coding off", "The description changes to Off for everyone without disconnecting GitHub.", await page.has("Off for everyone"));
    await maya.screenshot();
    await maya.click(cloudCodingSwitch);
    await maya.see({ text: /^On for 1 person, 4 repositories$/ });
  });
});

test("a teammate links their own GitHub account and sees the page read-only", async ({ world, user, probe, step, evidence }) => {
  const sam = user.on(world.teammate);
  const maya = user.on(world.owner);

  await step("before: the teammate sees the same page with the organization controls locked", async () => {
    // Each test owns a fresh Den, so Maya connects GitHub before Sam opens it.
    await maya.see(cloudCoding, { timeoutMs: 90_000 });
    await maya.click(cloudCoding);
    await maya.see(button(/^Connect GitHub$/), { timeoutMs: 90_000 });
    await maya.click(button(/^Connect GitHub$/));
    await maya.see(heading(/^Install & Authorize OpenWork$/));
    await maya.click(button(/^Install & Authorize$/));
    await maya.see({ text: /^On for everyone, 4 repositories$/ }, { timeoutMs: 90_000 });
    await sam.reload();
    await sam.see({ text: /^Only admins can change this$/ }, { timeoutMs: 90_000 });
    await sam.see(cloudCodingSwitch);
    await sam.notSee(button(/^Change on GitHub$/));
    await sam.notSee(button(/^Add repositories$/));
    await sam.notSee(button(/^Send link$/));
    expect((await probe.on(world.teammate).dom('button[role="switch"]:disabled')).elements).toHaveLength(1);
    const { body } = await probe.api(world.sam, overviewPath);
    expect(body).toMatchObject({ canManage: false, me: { canUse: true, github: null }, connection: { accountLogin: "acme" } });
    evidence.recordAssertionEvidence("Sam can see the connection but cannot manage it", "Only admins can change this appears beside the disabled switch. Change on GitHub, Add repositories, and Send link are absent.", await probe.on(world.teammate).has("Only admins can change this"));
    await sam.screenshot();
  });

  await step("the teammate links their own GitHub account", async () => {
    await sam.navigate(world.url(`${dashboardPath}/link`));
    await sam.see(heading(/^Link your GitHub account$/), { timeoutMs: 90_000 });
    world.github.signInAs("sam-rivera");
    await sam.click(button(/^Link your GitHub account$/));
    await sam.see({ text: /^GitHub linked$/ }, { timeoutMs: 90_000 });
    await sam.see({ text: /^Linked as sam-rivera$/ });
    expect(new URL(await probe.on(world.teammate).url()).pathname).toBe(`${dashboardPath}/link`);
    evidence.recordAssertionEvidence("Sam connects his own GitHub identity", "GitHub linked · Linked as sam-rivera.", await probe.on(world.teammate).has("Linked as sam-rivera"));
    await sam.screenshot();
  });

  await step("after: the admin's People list shows the teammate as linked", async () => {
    await maya.reload();
    await maya.see({ text: /^sam-rivera$/ }, { timeoutMs: 90_000 });
    await maya.wheelAt({ x: 1000, y: 800, deltaY: 850 });
    await maya.see(heading(/^Recent pull requests$/));
    const rows = (await probe.on(world.owner).dom("tr")).elements;
    expect(rows.find(row => row.text.includes("Sam Rivera"))?.text).toContain("sam-rivera");
    expect(rows.find(row => row.text.includes("Maya Chen (you)"))?.text).not.toContain("sam-rivera");
    evidence.recordAssertionEvidence("Sam's link appears on Sam's row", "Maya's People list shows Sam Rivera linked as sam-rivera, not on Maya's row.", rows.some(row => row.text.includes("Sam Rivera") && row.text.includes("sam-rivera")));
    await maya.screenshot();
  });
});

test("an organization owner without the feature does not see Cloud coding", async ({ world, user, probe, step, evidence }) => {
  const arjun = user.on(world.withoutFeature);
  await step("before: an organization without Cloud coding has no sidebar entry", async () => {
    await arjun.see({ role: "link", label: /^Connectors/ }, { timeoutMs: 30_000 });
    await arjun.notSee(cloudCoding);
    evidence.recordAssertionEvidence("Cloud coding is absent from the sidebar by default", "The sidebar shows Connectors but no Cloud coding entry.", !(await probe.on(world.withoutFeature).has("Cloud coding")));
    await arjun.screenshot();
  });
  await step("after: opening the Cloud coding address directly shows a not-found page", async () => {
    await arjun.navigate(world.url(dashboardPath));
    await arjun.see({ text: /this page could not be found/i }, { timeoutMs: 90_000 });
    await arjun.notSee(heading(/^Cloud coding$/));
    const { response } = await probe.api(world.arjun, overviewPath);
    expect(response.status).toBe(404);
    evidence.recordAssertionEvidence("A direct address cannot bypass the organization setting", "This page could not be found. The organization also receives a not-found response when it requests Cloud coding.", response.status === 404);
    await arjun.screenshot();
  });
});
