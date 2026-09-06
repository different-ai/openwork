import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { builtinBrowserWorld } from "../worlds/browser-panel.ts";

const test = spec.world(builtinBrowserWorld);

test("selected browser logins stay synced until the user pauses them", async ({ world, user, step, needs }) => {
  needs({ optIn: ["OPENWORK_EVAL_BROWSER_LOGIN_SYNC"] });
  const nowSeconds = Math.trunc(Date.now() / 1000);
  const sourceCookies = (value: string | null) => [
    ...(value === null ? [] : [{
      host: world.loginWitnessHost,
      name: "sid",
      value,
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: 1,
      expiresAt: nowSeconds + 3600,
      lastAccessedAt: nowSeconds - 5,
    }]),
    {
      host: ".chase.com",
      name: "auth",
      value: "bank-fixture",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: 1,
      expiresAt: nowSeconds + 3600,
      lastAccessedAt: nowSeconds - 60,
    },
  ];
  const store = await world.seedLoginStore("chosen", sourceCookies("login-v1-fixture"));
  const tab = await world.openLoginWitnessTab("sync");
  expect(await world.readLoginWitness(tab)).toBe("signed-out");

  await step("Permission alone does not read or configure a browser profile", async () => {
    await user.notSee({ testId: "login-sync-card" });
    const refused = await world.previewLoginStore(store.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/turned off/i);

    await world.openSettingsPanel("permissions");
    await user.click({ testId: "login-sync-permission-switch" });
    const permitted = await eventually(() => world.loginSyncState(), {
      within: 15_000,
      until: (value) => value.policyAllowed === true,
      label: "the local permission reaches main-process enforcement",
    });
    expect(permitted.policyAllowed).toBe(true);
    expect(permitted.configured).toBe(false);
    expect(permitted.active).toBe(false);
  });

  await step("The user chooses one profile and sites; finance stays unchecked", async () => {
    await world.showSession(world.session.sessionId);
    await user.see({ testId: "login-sync-card" }, { timeoutMs: 30_000 });
    await user.click({ testId: "login-sync-open" });
    await user.click({ testId: `login-sync-source-${store.id}` });
    await user.see({ testId: `login-sync-site-${world.loginWitnessHost}` }, { timeoutMs: 30_000 });
    expect(await world.readCheckedSyncSites()).toEqual([world.loginWitnessHost]);
    await user.click({ testId: "login-sync-confirm" });
    await user.see({ testId: "login-sync-done" }, { timeoutMs: 30_000 });
    await user.click({ text: "Done" });
    await user.notSee({ testId: "login-sync-card" });
  });

  await step("The initial HttpOnly login reaches the shared built-in browser without exposing its value", async () => {
    await world.reloadTab(tab);
    await eventually(() => world.readLoginWitness(tab), {
      within: 15_000,
      until: (value) => value === "signed-in-v1",
      label: "the selected login reaches the page",
    });
    expect(await world.signedInSites()).toEqual([world.loginWitnessHost]);
    const state = await world.loginSyncState();
    expect(state.active).toBe(true);
    expect(state.selectedSites).toEqual([world.loginWitnessHost]);
    expect(JSON.stringify(state)).not.toContain("login-v1-fixture");
    expect(JSON.stringify(state)).not.toContain("bank-fixture");

    const backgroundSession = await world.openSession("Background login work");
    await world.showSession(world.session.sessionId);
    const backgroundTab = await world.openLoginWitnessTabAs("background-sync", backgroundSession.sessionId);
    expect(backgroundTab.visible).toBe(false);
    await eventually(() => world.readLoginWitness(backgroundTab), {
      within: 15_000,
      until: (value) => value === "signed-in-v1",
      label: "a background conversation uses the shared synced login",
    });
  });

  await step("A source rotation and deletion propagate without another user action", async () => {
    await world.updateLoginStore(store.path, sourceCookies("login-v2-fixture"));
    await eventually(async () => {
      await world.reloadTab(tab);
      return world.readLoginWitness(tab);
    }, {
      within: 15_000,
      until: (value) => value === "signed-in-v2",
      label: "the source rotation reaches the built-in browser",
    });

    await world.updateLoginStore(store.path, sourceCookies(null));
    await eventually(async () => {
      await world.reloadTab(tab);
      return world.readLoginWitness(tab);
    }, {
      within: 15_000,
      until: (value) => value === "signed-out",
      label: "source deletion signs the built-in browser out",
    });
    expect(await world.signedInSites()).toEqual([]);
  });

  await step("Pause stops continuing reads", async () => {
    await world.openSettingsPanel("permissions");
    await user.see({ testId: "login-sync-configured" }, { timeoutMs: 30_000 });
    await user.click({ testId: "login-sync-pause" });
    await world.updateLoginStore(store.path, sourceCookies("login-v1-fixture"));
    const pausedAt = Date.now();
    const state = await eventually(async () => {
      const candidate = await world.loginSyncState();
      return { candidate, elapsed: Date.now() - pausedAt };
    }, {
      within: 10_000,
      until: ({ candidate, elapsed }) => candidate.status === "paused" && elapsed >= 6_000,
      label: "sync remains paused beyond its watcher and poll intervals",
    }).then((result) => result.candidate);
    await world.showSession(world.session.sessionId);
    await world.reloadTab(tab);
    expect(await world.readLoginWitness(tab)).toBe("signed-out");
    expect(state.active).toBe(false);
    expect(state.status).toBe("paused");
  });
});
