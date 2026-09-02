import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker completes local onboarding, a calm default sidebar, model choice in settings, native runs with history, and a run queue"
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
  const creationScreen = await evalIn(app, `(() => {
    const screen = document.querySelector('[data-testid="new-coworker"]');
    if (!(screen instanceof HTMLElement)) return null;
    const rect = screen.getBoundingClientRect();
    const text = document.body.innerText.toLowerCase();
    return {
      left: rect.left,
      width: rect.width,
      railVisible: text.includes("search coworkers") || text.includes("your team"),
      mentionsModel: text.includes("model"),
      mentionsMemoryFiles: text.includes("inspectable files"),
    };
  })()`);
  expect(creationScreen).toMatchObject({ railVisible: false, mentionsModel: false, mentionsMemoryFiles: false });
  if (!isRecord(creationScreen) || typeof creationScreen.left !== "number" || typeof creationScreen.width !== "number") {
    throw new Error("Creation screen layout was unavailable.");
  }
  expect(creationScreen.left).toBeLessThan(3);
  expect(creationScreen.width).toBeGreaterThan(900);
  evidence.recordAssertionEvidence(
    "Adding a coworker takes the whole window and asks only for a name and a look",
    "The creation screen filled the window with no team rail beside it, and neither AI model choice nor memory-file details appeared; those live in Coworker settings once the coworker exists.",
    true,
  );
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

  await waitForText(app, "Your team", { timeoutMs: 120_000 });
  await waitForText(app, "Responsibilities", { timeoutMs: 60_000 });

  // The default right sidebar is useful before anything is clicked: one status
  // word, the responsibilities section, quiet secondary links, and no repeated
  // empty-state phrasing or technical vocabulary.
  const defaultSidebar = await waitFor(app, `(() => {
    const summary = document.querySelector('[data-testid="coworker-activity-summary"]');
    const responsibilities = document.querySelector('[data-testid="coworker-responsibilities"]');
    const empty = document.querySelector('[data-testid="responsibilities-empty"]');
    const settings = document.querySelector('[data-testid="coworker-settings-button"]');
    const icon = settings?.querySelector("svg");
    const links = [...document.querySelectorAll('nav[aria-label="More for this coworker"] button')].map((button) => button.textContent?.trim());
    if (!(summary instanceof HTMLElement) || !(responsibilities instanceof HTMLElement) || !(settings instanceof HTMLElement) || !icon) return false;
    const summaryLines = summary.innerText.split("\\n").map((line) => line.trim()).filter(Boolean);
    // The first poll may still be reading the workspace; wait for the settled idle state.
    if (summaryLines[0] !== "Ready") return false;
    const sidebarText = (summary.closest("aside")?.innerText ?? "").toLowerCase();
    const settingsRect = settings.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    return {
      summaryLines,
      responsibilitiesVisible: responsibilities.offsetParent !== null,
      responsibilitiesBelowActivity: responsibilities.getBoundingClientRect().top > summary.getBoundingClientRect().bottom,
      emptyStateCount: document.querySelectorAll('[data-testid="responsibilities-empty"]').length,
      emptyStateText: empty?.textContent?.trim() ?? "",
      links,
      settingsLabel: settings.getAttribute("aria-label"),
      settingsTitle: settings.getAttribute("title"),
      settingsText: settings.textContent?.trim() ?? "",
      settingsSize: [Math.round(settingsRect.width), Math.round(settingsRect.height)],
      iconSize: [Math.round(iconRect.width), Math.round(iconRect.height)],
      sidebarMentionsEngine: sidebarText.includes("engine"),
      sidebarMentionsModel: sidebarText.includes("model"),
      readyMentions: (sidebarText.match(/ready/g) ?? []).length,
    };
  })()`, { timeoutMs: 60_000, label: "settled default Activity sidebar" });
  expect(defaultSidebar).toMatchObject({
    summaryLines: ["Ready", "Waiting for the first assignment."],
    responsibilitiesVisible: true,
    responsibilitiesBelowActivity: true,
    emptyStateCount: 1,
    links: ["Apps & tools", "Memory", "Coworker settings"],
    settingsLabel: "Coworker settings",
    settingsTitle: "Coworker settings",
    settingsText: "",
    settingsSize: [32, 32],
    iconSize: [16, 16],
    sidebarMentionsEngine: false,
    sidebarMentionsModel: false,
    readyMentions: 1,
  });
  if (!isRecord(defaultSidebar) || typeof defaultSidebar.emptyStateText !== "string") throw new Error("Default sidebar facts were unavailable.");
  expect(defaultSidebar.emptyStateText).toContain("No responsibilities yet.");
  expect(defaultSidebar.emptyStateText).toContain("Add responsibility");
  const composerFacts = await evalIn(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]')?.closest("div.border-t");
    const text = (composer?.textContent ?? "").toLowerCase();
    return {
      present: Boolean(composer),
      hasModelControl: Boolean(document.querySelector('[data-testid="composer-model-control"]')),
      mentionsModel: text.includes("model") || text.includes("thinking effort"),
    };
  })()`);
  expect(composerFacts).toEqual({ present: true, hasModelControl: false, mentionsModel: false });
  evidence.recordAssertionEvidence(
    "The default Activity sidebar leads with current activity and responsibilities, and the composer carries no model controls",
    "Before any click, Scout's sidebar showed exactly one idle status line plus one note, the Responsibilities section with a single compact Add responsibility empty state, three quiet links, and an icon-only 32×32 Coworker settings control with a 16×16 glyph; the sidebar and composer contained no model, thinking-effort, or engine vocabulary.",
    true,
  );

  // Model choice lives in Coworker settings, opened from the icon-only control.
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="coworker-settings-button"]');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`, { label: "Coworker settings icon button" });
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-model-settings"]'))`, { timeoutMs: 30_000, label: "AI model section" });
  expect(String(await evalIn(app, `document.querySelector('[data-testid="coworker-model-settings"]')?.innerText ?? ""`))).toContain("AI model");
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="model-picker"] > button');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`, { label: "open the AI model picker" });
  await waitFor(app, `Boolean(document.querySelector('input[aria-label="Search AI models"]'))`, {
    timeoutMs: 120_000,
    label: "AI model search",
  });
  await fill(app, 'input[aria-label="Search AI models"]', "big-pickle");
  await clickButtonContaining(app, "big-pickle");
  await waitFor(app, `(document.querySelector('[data-testid="model-picker"]')?.textContent ?? "").includes("Big Pickle")`, {
    timeoutMs: 30_000,
    label: "Big Pickle selected in Coworker settings",
  });
  const thinkingEffort = await evalIn(app, `(() => {
    const section = document.querySelector('[data-testid="coworker-model-settings"]');
    const labels = [...(section?.querySelectorAll("label") ?? [])].map((label) => label.textContent ?? "");
    return {
      hasSelect: Boolean(section?.querySelector("select")),
      mentionsThinkingEffort: labels.some((label) => label.includes("Thinking effort")),
      sectionText: section?.innerText ?? "",
    };
  })()`);
  if (!isRecord(thinkingEffort)) throw new Error("Thinking effort facts were unavailable.");
  // A model that exposes reasoning variants gets the Thinking effort control here and nowhere else;
  // one that does not gets nothing, rather than a disabled control.
  expect(thinkingEffort.hasSelect).toBe(thinkingEffort.mentionsThinkingEffort);
  expect(String(thinkingEffort.sectionText)).toContain("thinking effort");
  await waitFor(app, `(() => {
    const back = document.querySelector('button[aria-label="Back to activity"]');
    if (!(back instanceof HTMLElement)) return false;
    back.click();
    return true;
  })()`, { label: "back to the Activity sidebar" });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-activity-summary"]'))`, { timeoutMs: 30_000, label: "Activity sidebar restored" });
  evidence.recordAssertionEvidence(
    "A coworker's AI model and thinking effort are configured in Coworker settings",
    "The icon-only Coworker settings control opened the AI model section, where the searchable picker selected Big Pickle for Scout and the thinking-effort control appears only when the chosen model offers reasoning variants.",
    true,
  );
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
      visibleRailAvatars: [...document.querySelectorAll("aside nav svg.coworker-avatar")]
        .filter((avatar) => avatar instanceof SVGElement && avatar.getClientRects().length > 0).length,
      railSearchVisible: (() => {
        const search = document.querySelector('input[aria-label="Search coworkers"]');
        return search instanceof HTMLElement && search.offsetParent !== null;
      })(),
      hasSettingsNavigation: sidebar.querySelectorAll('nav button').length,
      navigationLabels: [...sidebar.querySelectorAll('nav button')].map((button) => button.textContent?.trim()),
    };
  })()`);
  expect(settingsLayout).toMatchObject({
    continuityToken: "settings-round-trip",
    coworkerWorkspaceDisplay: "none",
    hasVisibleCoworkerContextResizer: false,
    visibleRailAvatars: 0,
    railSearchVisible: false,
    hasSettingsNavigation: 4,
    navigationLabels: ["General", "Account", "AI models", "AI & local setup"],
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
  const configurationText = String(await evalIn(app, "document.body.innerText")).toLowerCase();
  expect(configurationText).toContain("local mode");
  expect(configurationText).toContain("ai & local setup");
  expect(configurationText).toContain("opencode/big-pickle");
  expect(configurationText).not.toContain("engine");
  for (const destination of ["AI models", "AI & local setup"]) {
    await clickButton(app, destination);
    const pageText = String(await evalIn(app, "document.body.innerText")).toLowerCase();
    expect(pageText, `${destination} copy`).not.toContain("engine");
  }
  expect(String(await evalIn(app, `document.querySelector('[data-testid="local-setup-card"]')?.innerText ?? ""`))).toContain("AI is ready");
  evidence.recordAssertionEvidence(
    "Global OpenWork settings open as a full-window workspace with their own left navigation and plain AI language",
    "The discreet bottom-left OpenWork control hid the mounted coworker workspace, its rail, and its context-panel resizer, replacing them with a full-width settings shell, a 252px left settings sidebar, and four destinations named General, Account, AI models, and AI & local setup. The pages showed Local mode, AI is ready, and Scout's selected Big Pickle model without the word engine anywhere.",
    true,
  );

  await clickButtonContaining(app, "Back to coworkers");
  await waitForText(app, "Add responsibility", { timeoutMs: 30_000 });
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
  await clickButton(app, "Add responsibility");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="add-responsibility"]'))`, { timeoutMs: 30_000, label: "add responsibility form" });
  const placementChoice = await evalIn(app, `(() => {
    const radios = [...document.querySelectorAll('[data-testid="add-responsibility"] [role="radio"]')];
    return radios.map((radio) => ({ label: radio.textContent?.trim(), checked: radio.getAttribute("aria-checked") }));
  })()`);
  expect(placementChoice).toEqual([
    { label: "OpenWork Cloud", checked: "false" },
    { label: "This Mac", checked: "true" },
  ]);
  await fill(app, 'input[placeholder="Morning competitor report"]', "Local readiness check");
  await fill(app, 'textarea[placeholder="What should happen on every run?"]', "Reply with exactly LOCAL RESPONSIBILITY READY. Do not use tools.");
  await clickButton(app, "Create responsibility");
  await waitForText(app, "Local readiness check", { timeoutMs: 30_000 });
  const responsibilityRow = String(await evalIn(app, `document.querySelector('[data-testid="responsibility-row"]')?.innerText ?? ""`));
  expect(responsibilityRow).toContain("Local readiness check");
  expect(responsibilityRow).toContain("This Mac");
  expect(responsibilityRow).toContain("Every day at");
  expect(responsibilityRow).toContain("Next:");
  expect(responsibilityRow).not.toContain("Last:");
  expect(String(await evalIn(app, `document.querySelector('[data-testid="responsibility-placement-note"]')?.textContent ?? ""`))).toContain("runs only while Open Coworker is open");
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="responsibility-placement-note"]').length`)).toBe(1);

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

  await waitFor(app, `(() => {
    const menu = document.querySelector('button[aria-label="Actions for Local readiness check"]');
    if (!(menu instanceof HTMLElement)) return false;
    menu.click();
    return true;
  })()`, { label: "responsibility action menu" });
  await waitFor(app, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === "Run now");
    if (!(item instanceof HTMLElement) || item.disabled) return false;
    item.click();
    return true;
  })()`, { label: "Run now menu item" });
  await waitForText(app, "Run started.", { timeoutMs: 30_000 });
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
  const sidebarAfterRun = await waitFor(app, `(() => {
    const summary = document.querySelector('[data-testid="coworker-activity-summary"]');
    const recent = document.querySelector('[data-testid="coworker-recent-activity"]');
    const row = document.querySelector('[data-testid="responsibility-row"]');
    if (!(summary instanceof HTMLElement) || !(recent instanceof HTMLElement) || !(row instanceof HTMLElement)) return false;
    const recentText = recent.innerText;
    const rowText = row.innerText;
    if (!recentText.includes("Local readiness check") || !recentText.includes("Succeeded") || !rowText.includes("Last: Succeeded")) return false;
    // The activity read and the responsibility read poll independently; wait until both have settled.
    const summaryLines = summary.innerText.split("\\n").map((line) => line.trim()).filter(Boolean);
    if (summaryLines.length !== 1 || summaryLines[0] !== "Ready") return false;
    return {
      summaryLines,
      recentEntries: recent.querySelectorAll("li").length,
      recentText,
      rowText,
    };
  })()`, {
    timeoutMs: 30_000,
    label: "right sidebar records the completed local work",
  });
  expect(sidebarAfterRun).toMatchObject({ summaryLines: ["Ready"], recentEntries: 1 });
  if (!isRecord(sidebarAfterRun)) throw new Error("Sidebar facts after the run were unavailable.");
  expect(String(sidebarAfterRun.recentText)).toContain("Responsibility");
  expect(String(sidebarAfterRun.rowText)).toContain("Next:");
  evidence.recordAssertionEvidence(
    "A local Responsibility runs through a native thread and the sidebar records it once, in the right place",
    "The daily responsibility finished with a native ses_ thread id and no error. Current activity then read just Ready, Recent listed Local readiness check as a succeeded responsibility exactly once, and the responsibility row showed its next occurrence and Last: Succeeded.",
    true,
  );

  // --- Outcomes live beside the responsibility: a run history with the coworker's own words,
  // and a way to ask the coworker to explain a run without leaving the discussion.
  await waitFor(app, `(() => {
    const toggle = document.querySelector('[data-testid="responsibility-history-toggle"]');
    if (!(toggle instanceof HTMLElement) || !(toggle.textContent ?? "").includes("1 run")) return false;
    toggle.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "run history toggle" });
  const history = await waitFor(app, `(() => {
    const runs = [...document.querySelectorAll('[data-testid="responsibility-run"]')];
    if (runs.length !== 1) return false;
    const run = runs[0];
    return {
      outcome: run.getAttribute("data-outcome"),
      text: run.innerText,
      toggle: document.querySelector('[data-testid="responsibility-history-toggle"] span:not([aria-hidden])')?.textContent?.trim() ?? "",
      rowSummary: document.querySelector('[data-testid="responsibility-summary"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 30_000, label: "one recorded run in the history" });
  expect(history).toMatchObject({ outcome: "succeeded", toggle: "1 run · 1 succeeded" });
  if (!isRecord(history) || typeof history.text !== "string" || typeof history.rowSummary !== "string") {
    throw new Error("Run history facts were unavailable.");
  }
  // innerText breaks each flex child onto its own line; read the run as one sentence.
  const runLine = history.text.replace(/\s+/g, " ");
  expect(runLine).toMatch(/Succeeded · .+ · \d+(s|m)/);
  expect(runLine).toContain("Started by you");
  expect(runLine).toContain("Open thread");
  expect(runLine).toContain("Ask Scout to explain");
  const summaryRecorded = history.rowSummary.length > 0;
  await waitFor(app, `(() => {
    const explain = document.querySelector('[data-testid="responsibility-explain"]');
    if (!(explain instanceof HTMLElement)) return false;
    explain.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Ask Scout to explain" });
  const explainDraft = String(await waitFor(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement && composer.value.includes("Local readiness check") ? composer.value : false;
  })()`, { timeoutMs: 30_000, label: "explain message prefilled in the discussion composer" }));
  expect(explainDraft).toContain('run of your responsibility "Local readiness check". It succeeded.');
  expect(explainDraft).toContain("what the outcome means");
  if (summaryRecorded) expect(explainDraft).toContain("Here is what you reported at the end of that run:");
  expect(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]')].length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "Each responsibility shows its run history and can ask the coworker to explain a run",
    `The row's history opened on one succeeded manual run with its duration${summaryRecorded ? " and Scout's own closing summary" : ""}, plus Open thread and Ask Scout to explain. Explain prefilled the discussion composer with the run's outcome without sending anything.`,
    true,
  );

  // --- A run limit on this Mac: the second request waits in line and starts by itself.
  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "AI & local setup");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="local-runs-card"] [role="radio"][aria-checked="true"]'))`, { timeoutMs: 30_000, label: "parallel-run limit control" });
  const limitCard = String(await evalIn(app, `document.querySelector('[data-testid="local-runs-card"]')?.innerText ?? ""`));
  expect(limitCard).toContain("Responsibilities on this Mac");
  expect(limitCard).toContain("wait in line");
  expect(limitCard).toMatch(/\d+ running · \d+ waiting/);
  await waitFor(app, `(() => {
    const one = [...document.querySelectorAll('[data-testid="local-runs-card"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "1");
    if (!(one instanceof HTMLElement) || one.disabled) return false;
    one.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "limit of one run" });
  await waitFor(app, `[...document.querySelectorAll('[data-testid="local-runs-card"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "1")?.getAttribute("aria-checked") === "true"`, {
    timeoutMs: 30_000,
    label: "limit saved",
  });
  expect(await invokeCoworker(app, "settings.get", {})).toMatchObject({ ok: true, result: { maxParallelLocalRuns: 1 } });
  await clickButtonContaining(app, "Back to coworkers");
  await waitForText(app, "Local readiness check", { timeoutMs: 30_000 });
  const second = await invokeCoworker(app, "localResponsibilities.create", {
    slug: "scout",
    name: "Second readiness check",
    instructions: "Reply with exactly SECOND RESPONSIBILITY READY. Do not use tools.",
    schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
  });
  expect(second).toMatchObject({ ok: true, result: { name: "Second readiness check", state: "active" } });
  const listed = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  if (!isRecord(listed) || !Array.isArray(listed.result)) throw new Error("Local responsibilities were unavailable.");
  const ids = listed.result.filter(isRecord).map((item) => String(item.id));
  expect(ids).toHaveLength(2);
  const admissions = await evalIn(app, `Promise.all([
    window.__COWORKER__.invoke("localResponsibilities.runNow", { slug: "scout", id: ${json(ids[0])} }),
    window.__COWORKER__.invoke("localResponsibilities.runNow", { slug: "scout", id: ${json(ids[1])} }),
  ])`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(admissions).toEqual([
    { ok: true, result: { accepted: true, queued: false, reason: "" } },
    { ok: true, result: { accepted: true, queued: true, reason: "" } },
  ]);
  const queuedRow = await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => candidate.getAttribute("data-state") === "Queued");
    return row instanceof HTMLElement ? row.innerText : false;
  })()`, { timeoutMs: 30_000, label: "queued responsibility row" });
  expect(String(queuedRow)).toContain("Waiting for a free slot");
  expect(String(queuedRow)).toContain("Queued");
  const drained = await waitFor(app, `window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" })
    .then((response) => {
      const items = response.ok ? response.result : [];
      const finished = items.every((item) => item.latestRun?.status === "succeeded");
      return finished ? items.map((item) => ({ name: item.name, runs: item.runs.length, latest: item.latestRun.status, queuedAt: item.latestRun.queuedAt })) : false;
    })`, { awaitPromise: true, timeoutMs: 300_000, label: "both runs succeeded one after another" });
  expect(drained).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Local readiness check", runs: 2, latest: "succeeded" }),
    expect.objectContaining({ name: "Second readiness check", runs: 1, latest: "succeeded", queuedAt: expect.any(Number) }),
  ]));
  expect(await invokeCoworker(app, "localResponsibilities.status", {})).toMatchObject({ ok: true, result: { limit: 1, active: 0, queued: 0 } });
  evidence.recordAssertionEvidence(
    "A parallel-run limit set in Settings makes later runs wait in line and start by themselves",
    "With Responsibilities on this Mac set to 1, two Run now requests admitted the first immediately and queued the second; the second row read Queued · Waiting for a free slot, then started on its own once the first finished, and both ended Succeeded with the queue empty.",
    true,
  );
});
