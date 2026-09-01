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
  expect(welcomeText).toContain("Connect OpenWork Cloud");
  expect(welcomeText).toContain("Start locally");
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
        whiteBody: mark.querySelector('path[fill="#f7f8fa"]') !== null,
        hasPointerLayer: pointerLayer !== null,
        lookX,
        lookY,
      });
    })));
  })()`, { awaitPromise: true });
  expect(brandGaze).toMatchObject({
    whiteBody: true,
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
    "First run presents the white Open Coworker identity with a restrained pointer-aware gaze",
    "The welcome surface used the white SVG coworker mark, offered both cloud and local paths, and moved only the pupil layer toward the pointer within a 1.5px horizontal cap.",
    true,
  );

  await clickButtonContaining(app, "Start locally");
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
    pupils: { animationName: "coworker-blink", animationDuration: "8.8s" },
    glasses: true,
  });
  if (!isRecord(avatarMotion)) throw new Error("Scout avatar motion layers were unavailable.");
  const animatedLayers = ["body", "depth", "features", "gaze", "pupils"]
    .map((key) => avatarMotion[key])
    .filter(isRecord);
  expect(new Set(animatedLayers.map((layer) => layer.animationDelay)).size).toBe(1);
  const coworkerGaze = await evalIn(app, `(() => {
    const avatar = document.querySelector('svg[aria-label="Scout avatar"].is-animated');
    if (!avatar) return null;
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: 2,
      clientY: window.innerHeight - 2,
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
    "Scout's body, rear depth, glasses/features, gaze, and blink shared the same 8.8 second phase, while only the nested pupil layer followed a lower-left pointer within 1.5px horizontal and 0.9px vertical caps.",
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

  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork configuration", { timeoutMs: 30_000 });
  const configurationText = await evalIn(app, "document.body.innerText");
  expect(configurationText.toLowerCase()).toContain("local mode");
  expect(configurationText.toLowerCase()).toContain("agent engine");
  expect(configurationText.toLowerCase()).toContain("opencode/big-pickle");
  evidence.recordAssertionEvidence(
    "Account, engine, provider, and model configuration stays available from the discreet bottom-left control",
    "The OpenWork control was within 24px of the window bottom and opened Local mode, Agent engine, and Scout's selected Big Pickle model without replacing the work surface.",
    true,
  );

  await clickButton(app, "←");
  await waitForText(app, "+ New local responsibility", { timeoutMs: 30_000 });
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
    return text.includes("Now") && text.includes("Last activity") && text.includes("Local readiness check")
      ? text
      : false;
  })()`, {
    timeoutMs: 30_000,
    label: "right sidebar shows the completed local work",
  });
  expect(activitySummary).toContain("No task is running");
  expect(activitySummary).toContain("Last activity");
  expect(activitySummary).toContain("Local readiness check");
  evidence.recordAssertionEvidence(
    "A local Responsibility runs through a native thread and leaves a clear record in the sidebar",
    "The daily responsibility finished with a native ses_ thread id and no error. The right sidebar then said no task was running and named Local readiness check as the last activity.",
    true,
  );
});
