import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminOrganizationRace } from "../worlds/den-admin-organization-race.ts";

const test = spec.world(adminOrganizationRace, {
  timeout: 180_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a platform admin keeps the organization inventory when an older overview finishes", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const adminProbe = probe.on(world.web);
  const navigate = async (url: string) => {
    const before = await adminProbe.documentState(url);
    await admin.navigate(url);
    await adminProbe.eventually(() => adminProbe.documentState(url), {
      within: 30_000, label: "the new admin document is ready",
      until: state => state.sameUrl && state.complete && state.timeOrigin !== before.timeOrigin,
    });
  };
  const inventory = async () => {
    const rows = await adminProbe.dom('[data-testid^="admin-org-row-"]');
    const busy = await adminProbe.dom('[aria-busy="true"]');
    return { rows: rows.elements.length, busy: busy.elements.some(element => element.rect.width > 0 && element.rect.height > 0) };
  };

  await step("warm the real overview cache without loading organizations", async () => {
    await navigate(world.adminUrl);
    await admin.see({ role: "button", label: /Organizations \(2\)/ });
    const warmed = await adminProbe.eventually(() => world.transport.requests(), {
      within: 30_000, label: "the original overview has completed",
      until: requests => requests.some(request => request.kind === "overview" && request.completed),
    });
    expect(warmed.find(request => request.kind === "overview")).toMatchObject({ status: 200, rows: 0, total: 2, held: false });
    await navigate(world.featuresUrl);
    evidence.recordAssertionEvidence("Warm cache comes from the real server", "The authorized overview returned HTTP 200, totalOrganizations=2, with its deferred organization list empty. No response or storage was fabricated.", true);
  });

  await step("load organizations while the older overview response is held", async () => {
    world.transport.hold();
    await navigate(world.adminUrl);
    await adminProbe.eventually(() => world.transport.requests(), {
      within: 30_000, label: "the genuine refresh response is held after server authorization",
      until: requests => requests.some(request => request.kind === "overview" && request.held && !request.completed),
    });
    await admin.click({ role: "button", label: /Organizations \(2\)/ });
    await adminProbe.eventually(inventory, {
      within: 30_000, label: "both live organization rows are visible before the old overview is released",
      until: state => state.rows === 2,
    });
    expect(world.transport.requests().find(request => request.kind === "organizations")).toMatchObject({ status: 200, rows: 2, total: 2, completed: true });
    expect(world.transport.requests().filter(request => request.held).every(request => !request.completed)).toBe(true);
    evidence.recordAssertionEvidence("The newer list wins the network race", JSON.stringify({ requests: world.transport.requests(), inventory: await inventory() }), true);
    await admin.screenshot();
  });

  await step("releasing the old overview preserves the settled organization rows", async () => {
    await world.transport.release();
    const samples: Awaited<ReturnType<typeof inventory>>[] = [];
    const started = Date.now();
    await adminProbe.eventually(async () => {
      samples.push(await inventory());
      return Date.now() - started;
    }, { within: 5_000, label: "observe the rendered inventory after the late response", until: elapsed => elapsed >= 1_000 });
    const settled = await inventory();
    const requests = world.transport.requests();
    const preserved = samples.every(sample => sample.rows === 2) && settled.rows === 2 && !settled.busy;
    evidence.recordAssertionEvidence("Late overview cannot erase newer rows", JSON.stringify({ requests, samples, settled }), preserved);
    await admin.screenshot();
    expect(requests.filter(request => request.held).every(request => request.completed)).toBe(true);
    expect(settled).toEqual({ rows: 2, busy: false });
    expect(samples.every(sample => sample.rows === 2)).toBe(true);
  });
});

const denials: (401 | 403)[] = [401, 403];
const faults: ("connection-reset" | "abort")[] = ["connection-reset", "abort"];
for (const status of denials) {
  for (const fault of faults) {
    test(`a real overview ${status} removes cached admin data after the newer organization read ${fault}`, async ({ world, user, probe, step, evidence }) => {
      const admin = user.on(world.web);
      const adminProbe = probe.on(world.web);
      const deniedTitle = status === 401 ? "Sign in required" : "Admin access required";
      const state = async () => {
        const headings = await adminProbe.dom("h1");
        const rows = await adminProbe.dom('[data-testid^="admin-org-row-"], [data-testid^="admin-user-row-"]');
        return {
          denied: headings.elements.some(element => element.text === deniedTitle),
          backoffice: headings.elements.some(element => element.text === "User backoffice"),
          rows: rows.elements.length,
          cached: await world.transport.cachePresent(),
        };
      };

      await step("warm the real admin cache, then revoke its actual server authority", async () => {
        await admin.navigate(world.adminUrl);
        await admin.see({ role: "button", label: /Organizations \(2\)/ });
        expect(await world.transport.cachePresent()).toBe(true);
        expect(world.transport.requests().find(request => request.kind === "overview")).toMatchObject({ status: 200, rows: 0, total: 2 });
        expect(await world.revokeAccess(status)).toBe(200);
        world.transport.hold();
        await admin.click({ role: "button", label: /^Refresh$/ });
        const requests = await adminProbe.eventually(() => world.transport.requests(), {
          within: 30_000, label: `the real Den HTTP ${status} overview is held`,
          until: reads => reads.some(read => read.kind === "overview" && read.status === status && read.held && !read.completed),
        });
        evidence.recordAssertionEvidence("Real authorization denial, not a synthetic response", JSON.stringify({ revocation: status === 401 ? "session sign-out" : "platform-admin allowlist removal", requests, state: await state() }), true);
      });

      await step("start a newer organization read which cannot deliver an authorization result", async () => {
        world.transport.failOrganizations(fault);
        await admin.click({ role: "button", label: /Organizations \(2\)/ });
        await adminProbe.eventually(() => world.transport.requests(), {
          within: 10_000, label: "the actual component started the newer organization fetch",
          until: reads => reads.some(read => read.kind === "organizations" && read.fault === fault),
        });
        if (fault === "abort") {
          await admin.click({ role: "button", label: /^Users \(/ });
        }
        const requests = await adminProbe.eventually(() => world.transport.requests(), {
          within: 10_000, label: "Chrome witnessed the organization network failure",
          until: reads => reads.some(read => read.kind === "organizations" && read.completed && Boolean(read.networkError)),
        });
        const failed = requests.find(read => read.kind === "organizations");
        expect(failed).toMatchObject({ status: null, completed: true, canceled: fault === "abort" });
        expect(failed?.networkError).toBe(fault === "abort" ? "net::ERR_ABORTED" : "net::ERR_CONNECTION_RESET");
        expect(await state()).toMatchObject({ denied: false, backoffice: true, cached: true });
        evidence.recordAssertionEvidence("The newer read supplies no denial or success", JSON.stringify({ requests, state: await state() }), true);
        await admin.screenshot();
      });

      await step("deliver the original denial and require access, payload and cache cleanup", async () => {
        await world.transport.release();
        const samples: Awaited<ReturnType<typeof state>>[] = [];
        const started = Date.now();
        await adminProbe.eventually(async () => {
          samples.push(await state());
          return Date.now() - started;
        }, { within: 5_000, label: "observe the settled denial after the held response", until: elapsed => elapsed >= 1_000 });
        const settled = await state();
        const clean = settled.denied && !settled.backoffice && settled.rows === 0 && !settled.cached;
        evidence.recordAssertionEvidence("An overview denial cannot be superseded by a failed organization read", JSON.stringify({ requests: world.transport.requests(), samples, settled }), clean);
        await admin.screenshot();
        expect(world.transport.requests().filter(read => read.held).every(read => read.completed)).toBe(true);
        expect(settled).toEqual({ denied: true, backoffice: false, rows: 0, cached: false });
      });

      await step("client navigation and a full reload cannot resurrect either admin cache", async () => {
        const before = await adminProbe.documentState(world.adminUrl);
        await admin.click({ role: "link", label: /^Features$/ });
        await adminProbe.eventually(() => adminProbe.documentState(world.featuresUrl), {
          within: 30_000, label: "Features is mounted without replacing the browser document",
          until: document => document.sameUrl && document.complete && document.timeOrigin === before.timeOrigin,
        });
        for (const navigation of ["client", "reload"]) {
          world.transport.hold();
          if (navigation === "client") {
            await admin.click({ role: "link", label: /^Overview$/ });
          } else {
            await admin.navigate(world.adminUrl);
          }
          await adminProbe.eventually(() => world.transport.requests(), {
            within: 30_000, label: `a fresh overview denial is pending after ${navigation}`,
            until: reads => reads.some(read => read.kind === "overview" && read.held && !read.completed),
          });
          const document = await adminProbe.documentState(world.adminUrl);
          expect(document.sameUrl).toBe(true);
          expect(document.timeOrigin === before.timeOrigin).toBe(navigation === "client");
          // The public loading skeleton shares the backoffice heading, but
          // must contain no cached admin data or organization controls.
          expect(await state()).toEqual({ denied: false, backoffice: true, rows: 0, cached: false });
          expect((await adminProbe.dom('section[aria-busy="true"]')).elements).toHaveLength(1);
          expect((await adminProbe.dom("button")).elements.some(element => /^Organizations \(/.test(element.text))).toBe(false);
          await world.transport.release();
          await admin.see({ role: "heading", label: new RegExp(`^${deniedTitle}$`) });
          expect(await state()).toEqual({ denied: true, backoffice: false, rows: 0, cached: false });
        }
        evidence.recordAssertionEvidence("Neither in-memory nor persisted admin data returns", "Next client navigation retained the document and module cache; a full reload then read sessionStorage. Neither rendered admin data while a new real denial was held.", true);
      });
    });
  }
}
