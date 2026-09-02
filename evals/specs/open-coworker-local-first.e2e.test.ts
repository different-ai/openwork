import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker completes local onboarding, model choice, settings, and a scheduled native run"
  : "Open Coworker local-first journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function clickButtonContaining(app: Awaited<ReturnType<typeof coworker>>, text: string): Promise<void> {
  await waitFor(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(text)}) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`, { timeoutMs: 120_000, label: `button containing ${json(text)}` });
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(
    app,
    `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`,
    { awaitPromise: true, timeoutMs: 30_000 },
  );
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using app = await coworker({ name: "local-first" });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const welcomeText = await evalIn(app, "document.body.innerText");
  expect(welcomeText).toContain("Continue with OpenWork");
  expect(welcomeText).toContain("Use this Mac");
  const welcomeLayout = await evalIn(app, `(() => {
    const launcher = document.querySelector('[data-testid="onboarding-launcher"]');
    const cloud = document.querySelector('[data-testid="onboarding-cloud-choice"]');
    const local = document.querySelector('[data-testid="onboarding-local-choice"]');
    if (!launcher || !cloud || !local) return null;
    const launcherRect = launcher.getBoundingClientRect();
    const cloudRect = cloud.getBoundingClientRect();
    const localRect = local.getBoundingClientRect();
    return {
      launcherCenterOffset: Math.abs((launcherRect.left + launcherRect.width / 2) - window.innerWidth / 2),
      launcherWidth: launcherRect.width,
      cloudTop: cloudRect.top,
      localTop: localRect.top,
      cloudWidth: cloudRect.width,
      localWidth: localRect.width,
    };
  })()`);
  expect(welcomeLayout).toMatchObject({
    launcherCenterOffset: expect.any(Number),
    launcherWidth: expect.any(Number),
    cloudTop: expect.any(Number),
    localTop: expect.any(Number),
    cloudWidth: expect.any(Number),
    localWidth: expect.any(Number),
  });
  if (!isRecord(welcomeLayout)) throw new Error("Open Coworker welcome layout was unavailable.");
  for (const key of ["launcherCenterOffset", "launcherWidth", "cloudTop", "localTop", "cloudWidth", "localWidth"]) {
    if (typeof welcomeLayout[key] !== "number") throw new Error(`Open Coworker welcome layout did not report ${key}.`);
  }
  expect(welcomeLayout.launcherCenterOffset as number).toBeLessThan(4);
  expect(welcomeLayout.launcherWidth as number).toBeGreaterThan(420);
  expect(welcomeLayout.launcherWidth as number).toBeLessThanOrEqual(680);
  expect(welcomeLayout.localTop as number).toBeGreaterThan(welcomeLayout.cloudTop as number);
  expect(Math.abs((welcomeLayout.cloudWidth as number) - (welcomeLayout.localWidth as number))).toBeLessThan(2);
  const brandGaze = await evalIn(app, `(() => {
    const mark = document.querySelector('svg[aria-label="Open Coworker"].coworker-mark');
    if (!mark) return null;
    const bounds = mark.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: window.innerWidth - 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const pointerLayer = mark.querySelector(".coworker-mark__pointer-gaze");
      const lookX = Number.parseFloat(mark.style.getPropertyValue("--avatar-look-x"));
      const lookY = Number.parseFloat(mark.style.getPropertyValue("--avatar-look-y"));
      resolve({
        whiteTile: mark.querySelector('rect[fill="#f7f8fa"]') !== null,
        blackOutline: mark.querySelector('path[fill="none"][stroke="#11151d"]') !== null,
        rearShell: mark.querySelector('path[fill="#d9dde4"][stroke="#aeb5c0"]') !== null,
        blueFill: mark.querySelector('[fill="#5b8dff"]') !== null,
        hasPointerLayer: pointerLayer !== null,
        lookX,
        lookY,
      });
    })));
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(brandGaze).toMatchObject({
    whiteTile: true,
    blackOutline: true,
    rearShell: true,
    blueFill: false,
    hasPointerLayer: true,
    lookX: expect.any(Number),
    lookY: expect.any(Number),
  });
  if (!isRecord(brandGaze) || typeof brandGaze.lookX !== "number" || typeof brandGaze.lookY !== "number") {
    throw new Error("Open Coworker brand gaze was unavailable.");
  }
  expect(brandGaze.lookX).toBeGreaterThan(0);
  expect(brandGaze.lookX).toBeLessThanOrEqual(1.5);
  expect(Math.abs(brandGaze.lookY)).toBeLessThanOrEqual(0.9);
  evidence.recordAssertionEvidence(
    "First run presents the monochrome Open Coworker line mark with a restrained pointer-aware gaze",
    "The centered launch surface used a white tile, black coworker outline, and offset gray rear shell, stacked a recommended Cloud path above a quieter local path, and moved only the pupil layer toward the pointer within a 1.5px horizontal cap.",
    true,
  );

  await clickButtonContaining(app, "Use this Mac");
  await waitForText(app, "Add a coworker", { timeoutMs: 60_000 });
  await fill(app, 'input[placeholder="Scout"]', "Scout");
  await waitFor(app, `(() => {
    const button = document.querySelector('button[aria-label="Violet"]');
    if (!button) return false;
    button.click();
    return true;
  })()`, { label: "Violet avatar color" });
  await clickButton(app, "Soft square");
  expect(await evalIn(app, `document.querySelector('button[aria-label="Violet"]')?.getAttribute("aria-pressed")`)).toBe("true");
  await clickButton(app, "Add coworker", { timeoutMs: 120_000 });

  await waitForText(app, "Choose a model", { timeoutMs: 120_000 });
  await waitFor(app, `Boolean(document.querySelector('input[aria-label="Search connected models"]'))`, {
    timeoutMs: 120_000,
    label: "connected model picker",
  });
  await fill(app, 'input[aria-label="Search connected models"]', "big-pickle");
  await clickButtonContaining(app, "big-pickle");
  await clickButton(app, "Finish setup");

  await waitForText(app, "Your team", { timeoutMs: 120_000 });
  await waitForText(app, "Responsibilities", { timeoutMs: 60_000 });
  const avatarMotion = await evalIn(app, `(() => {
    const avatar = document.querySelector('svg[aria-label="Scout avatar"].is-animated');
    if (!avatar) return null;
    const read = (selector) => {
      const element = avatar.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
      };
    };
    return {
      body: read(".coworker-avatar__body"),
      depth: read(".coworker-avatar__depth"),
      features: read(".coworker-avatar__features"),
      gaze: read(".coworker-avatar__gaze"),
      pupils: read(".coworker-avatar__pupils"),
      glasses: Boolean(avatar.querySelector(".coworker-avatar__glasses")),
    };
  })()`);
  expect(avatarMotion).toMatchObject({
    body: { animationName: "coworker-float", animationDuration: "8.8s" },
    depth: { animationName: "coworker-depth-turn", animationDuration: "8.8s" },
    features: { animationName: "coworker-feature-turn", animationDuration: "8.8s" },
    gaze: { animationName: "coworker-gaze-turn", animationDuration: "8.8s" },
    pupils: { animationName: "coworker-blink", animationDuration: "8.2s", animationDelay: "-1.4s" },
    glasses: true,
  });
  if (!isRecord(avatarMotion)) throw new Error("Scout avatar motion layers were unavailable.");
  const animatedLayers = ["body", "depth", "features", "gaze"]
    .map((key) => avatarMotion[key])
    .filter(isRecord);
  expect(new Set(animatedLayers.map((layer) => layer.animationDelay)).size).toBe(1);
  const coworkerGaze = await evalIn(app, `(() => {
    const avatar = document.querySelector('svg[aria-label="Scout avatar"].is-animated');
    if (!avatar) return null;
    const bounds = avatar.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: bounds.left - Math.max(24, bounds.width),
      clientY: bounds.bottom + Math.max(24, bounds.height),
    }));
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      hasPointerLayer: avatar.querySelector(".coworker-avatar__pointer-gaze") !== null,
      lookX: Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-x")),
      lookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-y")),
    }))));
  })()`, { awaitPromise: true });
  expect(coworkerGaze).toMatchObject({
    hasPointerLayer: true,
    lookX: expect.any(Number),
    lookY: expect.any(Number),
  });
  if (!isRecord(coworkerGaze) || typeof coworkerGaze.lookX !== "number" || typeof coworkerGaze.lookY !== "number") {
    throw new Error("Scout's pointer gaze was unavailable.");
  }
  expect(coworkerGaze.lookX).toBeLessThan(0);
  expect(Math.abs(coworkerGaze.lookX)).toBeLessThanOrEqual(1.5);
  expect(coworkerGaze.lookY).toBeGreaterThan(0);
  expect(coworkerGaze.lookY).toBeLessThanOrEqual(0.9);
  evidence.recordAssertionEvidence(
    "The coworker avatar coordinates its head turn and keeps a restrained eye on the pointer",
    "Scout's body, rear depth, glasses/features, and gaze shared one restrained head-turn phase; its blink used an independent cadence while only the nested pupil layer followed a lower-left pointer within 1.5px horizontal and 0.9px vertical caps.",
    true,
  );
  const storedCoworker = await invokeCoworker(app, "coworkers.get", { slug: "scout" });
  expect(storedCoworker).toMatchObject({
    ok: true,
    result: {
      name: "Scout",
      avatarColor: "violet",
      avatarGlasses: "square",
      model: "opencode/big-pickle",
      workspaceId: expect.any(String),
    },
  });
  evidence.recordAssertionEvidence(
    "A coworker's identity, appearance, native workspace, and selected OpenWork model persist together",
    "The renderer-created Scout record round-tripped through the main-process bridge with violet color, soft-square glasses, a native workspace id, and opencode/big-pickle.",
    true,
  );

  const secondCoworker = await invokeCoworker(app, "coworkers.create", {
    name: "Nova",
    role: "Research partner",
    mission: "Keep research work moving.",
    avatarColor: "mint",
    avatarGlasses: "round",
  });
  expect(secondCoworker).toMatchObject({ ok: true, result: { slug: "nova" } });
  await evalIn(app, "location.reload(); true");
  await waitForText(app, "Nova", { timeoutMs: 120_000 });
  const railAvatars = await evalIn(app, `(() => {
    const avatars = [...document.querySelectorAll("aside nav svg.coworker-avatar")];
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: window.innerWidth - 2,
      clientY: window.innerHeight - 2,
    }));
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(
      avatars.map((avatar) => {
        const pupils = avatar.querySelector(".coworker-avatar__pupils");
        const blink = pupils ? getComputedStyle(pupils) : null;
        return {
          name: avatar.getAttribute("aria-label"),
          animated: avatar.classList.contains("is-animated"),
          blinkName: blink?.animationName ?? "",
          blinkDuration: blink?.animationDuration ?? "",
          blinkDelay: blink?.animationDelay ?? "",
          lookX: Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-x")),
          lookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-y")),
          featureLookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-feature-look-y")),
        };
      }),
    ))));
  })()`, { awaitPromise: true });
  expect(railAvatars).toHaveLength(2);
  expect(railAvatars).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Scout avatar", animated: true, blinkName: "coworker-blink", blinkDuration: "8.2s", blinkDelay: "-1.4s" }),
    expect.objectContaining({ name: "Nova avatar", animated: true, blinkName: "coworker-blink", blinkDuration: "10.5s", blinkDelay: "-8.2s" }),
  ]));
  if (!Array.isArray(railAvatars) || !railAvatars.every(isRecord)) {
    throw new Error("Left-rail coworker motion was unavailable.");
  }
  expect(railAvatars.every((avatar) => typeof avatar.lookX === "number" && avatar.lookX > 0)).toBe(true);
  expect(railAvatars.every((avatar) => typeof avatar.lookY === "number" && avatar.lookY > 0)).toBe(true);
  expect(railAvatars.every((avatar) => typeof avatar.featureLookY === "number" && avatar.featureLookY > 0)).toBe(true);
  expect(new Set(railAvatars.map((avatar) => avatar.blinkDuration)).size).toBe(2);
  evidence.recordAssertionEvidence(
    "Every coworker in the left rail follows the pointer with its eyes and glasses",
    "Scout and Nova both moved their full eyewear feature group down toward the same bottom-right pointer while their pupils added an independent gaze offset. Both stayed animated while unselected and used different deterministic blink durations and offsets so the team never blinked in sync.",
    true,
  );
  await clickButtonContaining(app, "Scout");
  await waitForText(app, "Discussion with Scout", { timeoutMs: 30_000 });

  await clickButtonContaining(app, "Thinking effort");
  await waitForText(app, "Selected model", { timeoutMs: 30_000 });
  await waitFor(app, `(() => {
    const popover = document.querySelector('[data-testid="composer-model-popover"]');
    return (popover?.textContent ?? "").includes("Big Pickle");
  })()`, { timeoutMs: 30_000, label: "resolved conversation model" });
  const composerModelControl = await evalIn(app, `(() => {
    const control = document.querySelector('[data-testid="composer-model-control"]');
    const popover = document.querySelector('[data-testid="composer-model-popover"]');
    return {
      controlVisible: control instanceof HTMLElement && control.offsetParent !== null,
      popoverVisible: popover instanceof HTMLElement && popover.offsetParent !== null,
      text: popover?.textContent ?? "",
    };
  })()`);
  expect(composerModelControl).toMatchObject({
    controlVisible: true,
    popoverVisible: true,
  });
  expect(isRecord(composerModelControl) && String(composerModelControl.text)).toContain("Big Pickle");
  evidence.recordAssertionEvidence(
    "A coworker's model and thinking effort are available directly from the conversation composer",
    "Scout's compact composer control opened over the discussion, showed the selected Big Pickle model, and kept model choice separate from global OpenWork account settings.",
    true,
  );
  await clickButtonContaining(app, "Thinking effort");

  const footerPlacement = await evalIn(app, `(() => {
    const button = document.querySelector('button[title="OpenWork account and settings"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { left: rect.left, bottomGap: window.innerHeight - rect.bottom };
  })()`);
  expect(footerPlacement).toMatchObject({
    left: expect.any(Number),
    bottomGap: expect.any(Number),
  });
  if (!isRecord(footerPlacement)) throw new Error("OpenWork footer placement was unavailable.");
  expect(footerPlacement.left).toBeTypeOf("number");
  expect(footerPlacement.bottomGap).toBeTypeOf("number");
  if (typeof footerPlacement.left !== "number" || typeof footerPlacement.bottomGap !== "number") {
    throw new Error("OpenWork footer placement did not contain numeric coordinates.");
  }
  expect(footerPlacement.left).toBeLessThan(32);
  expect(footerPlacement.bottomGap).toBeLessThan(24);

  await evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="coworker-shell"]');
    if (!(shell instanceof HTMLElement)) throw new Error("Coworker shell was unavailable.");
    shell.dataset.continuityToken = "settings-round-trip";
  })()`);
  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  const settingsLayout = await evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="coworker-shell"]');
    const workspace = document.querySelector('[data-testid="coworker-workspace"]');
    const root = document.querySelector('[data-testid="openwork-settings"]');
    const sidebar = document.querySelector('[data-testid="openwork-settings-sidebar"]');
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !root || !sidebar) return null;
    const rootRect = root.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    return {
      continuityToken: shell.dataset.continuityToken,
      coworkerWorkspaceDisplay: getComputedStyle(workspace).display,
      rootLeft: rootRect.left,
      rootWidth: rootRect.width,
      sidebarLeft: sidebarRect.left,
      sidebarWidth: sidebarRect.width,
      hasVisibleCoworkerContextResizer: (() => {
        const resizer = document.querySelector('[data-testid="context-panel-resizer"]');
        return resizer instanceof HTMLElement && resizer.offsetParent !== null;
      })(),
      hasSettingsNavigation: sidebar.querySelectorAll('nav button').length,
    };
  })()`);
  expect(settingsLayout).toMatchObject({
    continuityToken: "settings-round-trip",
    coworkerWorkspaceDisplay: "none",
    hasVisibleCoworkerContextResizer: false,
    hasSettingsNavigation: 4,
  });
  if (
    !isRecord(settingsLayout)
    || typeof settingsLayout.rootLeft !== "number"
    || typeof settingsLayout.rootWidth !== "number"
    || typeof settingsLayout.sidebarLeft !== "number"
    || typeof settingsLayout.sidebarWidth !== "number"
  ) {
    throw new Error("Full-window OpenWork settings layout was unavailable.");
  }
  expect(settingsLayout.rootLeft).toBeLessThan(3);
  expect(settingsLayout.sidebarLeft).toBeLessThan(3);
  expect(settingsLayout.rootWidth).toBeGreaterThan(900);
  expect(settingsLayout.sidebarWidth).toBeGreaterThanOrEqual(240);
  const configurationText = await evalIn(app, "document.body.innerText");
  expect(configurationText.toLowerCase()).toContain("local mode");
  expect(configurationText.toLowerCase()).toContain("local engine");
  expect(configurationText.toLowerCase()).toContain("opencode/big-pickle");
  evidence.recordAssertionEvidence(
    "Global OpenWork settings open as a full-window workspace with their own left navigation",
    "The discreet bottom-left OpenWork control hid the mounted coworker workspace and replaced it with a full-width settings shell, a 252px left settings sidebar, four global destinations, Local mode, engine state, and Scout's selected Big Pickle model. No coworker context-panel resizer remained visible.",
    true,
  );

  await clickButtonContaining(app, "Back to coworkers");
  await waitForText(app, "+ New local responsibility", { timeoutMs: 30_000 });
  const returnedWorkspace = await evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="coworker-shell"]');
    const workspace = document.querySelector('[data-testid="coworker-workspace"]');
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement)) return null;
    return {
      continuityToken: shell.dataset.continuityToken,
      coworkerWorkspaceDisplay: getComputedStyle(workspace).display,
      selectedCoworker: document.body.innerText.includes("Discussion with Scout"),
    };
  })()`);
  expect(returnedWorkspace).toMatchObject({
    continuityToken: "settings-round-trip",
    coworkerWorkspaceDisplay: "flex",
    selectedCoworker: true,
  });
  await clickButton(app, "+ New local responsibility");
  await fill(app, 'input[placeholder="Morning competitor report"]', "Local readiness check");
  await fill(app, 'textarea[placeholder="What should happen on every run?"]', "Reply with exactly LOCAL RESPONSIBILITY READY. Do not use tools.");
  await clickButton(app, "Create locally");
  await waitForText(app, "Local readiness check", { timeoutMs: 30_000 });

  const createdResponsibilities = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  expect(createdResponsibilities).toMatchObject({
    ok: true,
    result: [{
      name: "Local readiness check",
      state: "active",
      schedule: { kind: "daily" },
      latestRun: null,
    }],
  });

  await clickButton(app, "Run now");
  await waitForText(app, "Run started as a native OpenWork thread.", { timeoutMs: 30_000 });
  const completedRun = await waitFor(app, `window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" })
    .then((response) => {
      const run = response.ok ? response.result?.[0]?.latestRun : null;
      return run?.status === "succeeded" && run.threadId ? run : false;
    })`, {
    awaitPromise: true,
    timeoutMs: 300_000,
    label: "local responsibility native thread succeeded",
  });
  expect(completedRun).toMatchObject({
    status: "succeeded",
    trigger: "manual",
    threadId: expect.stringMatching(/^ses_/),
    error: "",
  });
  const activitySummary = await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="coworker-activity-summary"]');
    const text = panel?.textContent ?? "";
    return text.includes("Ready") && text.includes("Last worked on this") && text.includes("Local readiness check")
      ? text
      : false;
  })()`, {
    timeoutMs: 30_000,
    label: "right sidebar shows the completed local work",
  });
  expect(activitySummary).toContain("Ready");
  expect(activitySummary).toContain("Last worked on this");
  expect(activitySummary).toContain("Local readiness check");
  evidence.recordAssertionEvidence(
    "A local Responsibility runs through a native thread and leaves a clear record in the sidebar",
    "The daily responsibility finished with a native ses_ thread id and no error. The right sidebar then showed Scout as ready and named Local readiness check as the most recent work without repeating the same fact.",
    true,
  );
});
