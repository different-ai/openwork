import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { connect, debuggerUrlFor, evaluate, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "dynamic-artifact-runtime";
const EVAL_WORKSPACE = resolve(
  process.env.OPENWORK_EVAL_ARTIFACTS_DIR ?? "evals/results",
  "..",
  "dynamic-artifact-runtime-workspace",
);
const PROJECT_ID = "launch-radar";
const INSTANCE_ID = `launch-radar-eval-${Date.now().toString(36)}`;
const PROJECT_ROOT = `[data-ui-artifact-project="${PROJECT_ID}"]`;
const FRAME = `${PROJECT_ROOT} iframe`;
const STUDIO = "[data-ui-artifact-studio]";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  sessionRoute: null,
  projectRevision: null,
  stateRevision: null,
  originalSource: null,
  enhancedProjectRevision: null,
};

function actionAvailable(actionId) {
  return `window.__openworkControl.listActions()
    .some((action) => action.id === ${JSON.stringify(actionId)} && !action.disabled)`;
}

async function dismissOnboardingPrompts(ctx) {
  const firstStep = await ctx.waitFor(`(() => {
    const ready = window.__openworkControl.listActions()
      .some((action) => action.id === "session.create_task" && !action.disabled);
    if (ready) return "ready";
    const text = document.body.innerText;
    if (text.includes("Skip and use the free model")) return "provider";
    if (text.includes("How did you hear about OpenWork?")) return "survey";
    return null;
  })()`, {
    timeoutMs: 60_000,
    label: "task creation or first-run prompt",
  });
  if (firstStep === "provider") {
    await ctx.clickText("Skip and use the free model", {
      selector: "button",
      timeoutMs: 10_000,
    });
  }
  const secondStep = firstStep === "ready"
    ? "ready"
    : await ctx.waitFor(`(() => {
      const ready = window.__openworkControl.listActions()
        .some((action) => action.id === "session.create_task" && !action.disabled);
      if (ready) return "ready";
      return document.body.innerText.includes("How did you hear about OpenWork?")
        ? "survey"
        : null;
    })()`, {
      timeoutMs: 30_000,
      label: "task creation or attribution prompt",
    });
  if (firstStep === "survey" || secondStep === "survey") {
    await ctx.clickText("Skip", { selector: "button", timeoutMs: 10_000 });
  }
}

async function ensureWorkspace(ctx) {
  await mkdir(EVAL_WORKSPACE, { recursive: true });

  const route = await ctx.eval("String(window.__openworkControl.snapshot().route || '')");
  if (route.includes("/settings")) {
    await ctx.navigateHash("/");
    await ctx.waitFor(
      `!String(window.__openworkControl.snapshot().route || "").includes("/settings")`,
      { timeoutMs: 30_000, label: "return to workspace from settings" },
    );
  }

  if (await ctx.eval(actionAvailable("session.create_task"))) return;
  if (
    (await ctx.hasText("Skip and use the free model")) ||
    (await ctx.hasText("How did you hear about OpenWork?"))
  ) {
    await dismissOnboardingPrompts(ctx);
    if (await ctx.eval(actionAvailable("session.create_task"))) return;
  }

  if (await ctx.hasText("Use Without Cloud")) {
    await ctx.clickText("Use Without Cloud", {
      selector: "button",
      timeoutMs: 15_000,
    });
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 30_000,
      label: "OpenWork control API after local-mode selection",
    });
  }

  const welcomeInput = 'input[placeholder="/workspace/my-project"]';
  if (await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(welcomeInput)}))`)) {
    await ctx.fill(welcomeInput, EVAL_WORKSPACE);
    await ctx.clickText("Use this folder", {
      selector: "button",
      timeoutMs: 15_000,
    });
  } else if (!(await ctx.eval(actionAvailable("session.create_task")))) {
    await ctx.waitFor(actionAvailable("workspace.create"), {
      timeoutMs: 30_000,
      label: "workspace.create action",
    });
    await ctx.control("workspace.create", { path: EVAL_WORKSPACE });
  }

  await dismissOnboardingPrompts(ctx);
  await ctx.waitFor(actionAvailable("session.create_task"), {
    timeoutMs: 60_000,
    label: "task creation after isolated workspace setup",
  });
}

async function dismissStartupPromo(ctx) {
  if (!(await ctx.hasText("Start working without API keys"))) return;
  if (await ctx.hasText("Continue with my own provider keys")) {
    await ctx.clickText("Continue with my own provider keys", {
      selector: "button",
      timeoutMs: 10_000,
    });
  } else {
    const closed = await ctx.eval(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]')]
        .find((element) => element.textContent?.includes("Start working without API keys"));
      const button = dialog?.querySelector('button[aria-label="Close"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    ctx.assert(closed, "The OpenWork Models startup dialog could not be dismissed.");
  }
  await ctx.waitFor(
    `!document.body.innerText.includes("Start working without API keys")`,
    { timeoutMs: 10_000, label: "OpenWork Models startup dialog dismissed" },
  );
}

async function ensureSession(ctx) {
  const route = await ctx.eval("window.__openworkControl.snapshot().route");
  if (typeof route === "string" && route.includes("/session/")) {
    state.sessionRoute = route;
    await dismissStartupPromo(ctx);
    return;
  }

  await ctx.waitFor(actionAvailable("session.create_task"), {
    timeoutMs: 60_000,
    label: "enabled session.create_task action",
  });
  await ctx.control("session.create_task");
  state.sessionRoute = await ctx.waitFor(
    `(() => {
      const next = window.__openworkControl.snapshot().route;
      return typeof next === "string" && next.includes("/session/") ? next : null;
    })()`,
    { timeoutMs: 60_000, label: "session route after task creation" },
  );
  await dismissStartupPromo(ctx);
}

async function readAttachment(ctx) {
  return ctx.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(PROJECT_ROOT)});
    const frame = root?.querySelector("iframe");
    return {
      found: Boolean(root),
      text: root?.innerText ?? "",
      frameState: root?.querySelector("[data-ui-artifact-frame-state]")
        ?.getAttribute("data-ui-artifact-frame-state") ?? null,
      projectRevision: root?.getAttribute("data-ui-artifact-project-revision"),
      stateRevision: root?.getAttribute("data-ui-artifact-state-revision"),
      stateSummary: root?.getAttribute("data-ui-artifact-state-summary"),
      sandbox: frame?.getAttribute("sandbox") ?? "",
      referrerPolicy: frame?.getAttribute("referrerpolicy") ?? "",
      allow: frame?.getAttribute("allow") ?? "",
      srcdoc: frame?.getAttribute("srcdoc") ?? "",
    };
  })()`);
}

async function waitForReadyAttachment(ctx) {
  await ctx.waitFor(
    `Boolean(document.querySelector(${JSON.stringify(`${PROJECT_ROOT} [data-ui-artifact-frame-state="ready"]`)}))`,
    { timeoutMs: 60_000, label: "ready Launch Radar chat attachment" },
  );
  return readAttachment(ctx);
}

async function openStudioFromAttachment(ctx) {
  await ctx.clickText("Open editor", {
    selector: `${PROJECT_ROOT} button`,
    timeoutMs: 30_000,
  });
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(STUDIO)}))`, {
    timeoutMs: 30_000,
    label: "dynamic artifact studio",
  });
}

async function openArtifactLibrary(ctx) {
  const panelOpen = await ctx.eval(
    `document.querySelector('button[aria-label="UI Artifacts"]')?.getAttribute("aria-pressed") === "true"`,
  );
  if (!panelOpen) {
    await ctx.trustedClick('button[aria-label="UI Artifacts"]', {
      timeoutMs: 30_000,
    });
  }
  await ctx.waitForText("UI artifacts", { timeoutMs: 30_000 });
  const generatedSelected = await ctx.eval(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((item) => item.textContent?.trim() === "Generated");
    return tab?.getAttribute("aria-selected") === "true";
  })()`);
  if (!generatedSelected) {
    await ctx.clickText("Generated", {
      selector: '[role="tab"]',
      timeoutMs: 30_000,
    });
  }
  if (
    await ctx.eval(
      `Boolean(document.querySelector('button[aria-label="Back to generated projects"]'))`,
    )
  ) {
    await ctx.trustedClick('button[aria-label="Back to generated projects"]', {
      timeoutMs: 30_000,
    });
  }
  await ctx.waitFor(
    `document.querySelector(${JSON.stringify(STUDIO)})?.getAttribute("data-ui-artifact-studio-tab") === "library"`,
    { timeoutMs: 30_000, label: "generated artifact library" },
  );
}

async function closeArtifactPanel(ctx) {
  if (await ctx.eval(`Boolean(document.querySelector('button[aria-label="Close UI artifacts"]'))`)) {
    await ctx.trustedClick('button[aria-label="Close UI artifacts"]', {
      timeoutMs: 30_000,
    });
    await ctx.waitFor(
      `!document.querySelector('button[aria-label="Close UI artifacts"]')`,
      { timeoutMs: 30_000, label: "UI artifacts panel closed" },
    );
  }
}

async function selectProjectFile(ctx, file) {
  await ctx.clickText(file, {
    selector: `${STUDIO} button`,
    timeoutMs: 30_000,
  });
  await ctx.waitFor("Boolean(window.__artifactEditorView?.state?.doc)", {
    timeoutMs: 30_000,
    label: `${file} CodeMirror document`,
  });
}

async function readEditorText(ctx) {
  return ctx.eval(`window.__artifactEditorView?.state?.doc?.toString() ?? ""`);
}

async function replaceEditorText(ctx, nextText) {
  const result = await ctx.eval(`(() => {
    const view = window.__artifactEditorView;
    if (!view?.dispatch || !view.state?.doc) return "no-view";
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: ${JSON.stringify(nextText)},
      },
    });
    view.focus();
    return view.state.doc.toString();
  })()`);
  ctx.assert(result === nextText, "The artifact source editor did not accept the requested content.");
}

async function clickArtifactButton(ctx, label) {
  ctx.assert(Boolean(ctx.cdpBaseUrl), "The artifact interaction proof requires a CDP endpoint.");
  const targets = await listTargets(ctx.cdpBaseUrl);
  for (const target of targets.filter((candidate) => (
    candidate.type === "iframe" &&
    candidate.url === "about:srcdoc" &&
    candidate.webSocketDebuggerUrl
  ))) {
    const frameClient = await connect(debuggerUrlFor(ctx.cdpBaseUrl, target));
    try {
      const clicked = await evaluate(frameClient, `(() => {
          const button = [...document.querySelectorAll("button")]
            .find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
          if (!button) return false;
          button.scrollIntoView({ block: "center", inline: "center" });
          button.click();
          return true;
        })()`);
      if (clicked === true) return;
    } catch {
      // Opaque iframe targets can disappear while React remounts. Try the next one.
    } finally {
      frameClient.close();
    }
  }
  ctx.assert(false, `Could not find the ${JSON.stringify(label)} control inside an artifact frame.`);
}

export default {
  id: FLOW_ID,
  title: "A described React artifact renders safely, stays interactive, and has a managed reusable lifecycle",
  kind: "user-facing",
  spec: "evals/voiceovers/dynamic-artifact-runtime.md",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "OpenWork control API",
    });
    await ensureWorkspace(ctx);
    const availability = await ctx.eval(`(() => {
      const create = window.__openworkControl.listActions()
        .find((action) => action.id === "session.create_task");
      return create && !create.disabled
        ? { ok: true }
        : { ok: false, reason: "The selected workspace cannot create a task." };
    })()`);
    return availability?.ok ? null : availability?.reason;
  },
  steps: [
    {
      name: "Frame 1 — enable the managed builder skill",
      run: async (ctx) => {
        await ctx.prove("The workspace explicitly enables its injected Artifact Builder skill and manages it beside the project library", {
          voiceover: vo[0],
          action: async () => {
            await ensureSession(ctx);
            await ctx.waitFor(actionAvailable("ui-artifacts.seed-dynamic-project"), {
              timeoutMs: 30_000,
              label: "dynamic artifact project seed action",
            });
            await ctx.control("ui-artifacts.seed-dynamic-project", {
              projectId: PROJECT_ID,
              instanceId: INSTANCE_ID,
            });
            const attachment = await waitForReadyAttachment(ctx);
            state.projectRevision = attachment.projectRevision;
            state.stateRevision = attachment.stateRevision;
            const panelOpen = await ctx.eval(
              `document.querySelector('button[aria-label="UI Artifacts"]')?.getAttribute("aria-pressed") === "true"`,
            );
            if (!panelOpen) {
              await ctx.trustedClick('button[aria-label="UI Artifacts"]', {
                timeoutMs: 30_000,
              });
            }
            if (await ctx.eval(`Boolean(document.querySelector('button[aria-label="Back to generated projects"]'))`)) {
              await ctx.trustedClick('button[aria-label="Back to generated projects"]', {
                timeoutMs: 30_000,
              });
            }
            await ctx.waitForText("Artifact Builder skill", { timeoutMs: 30_000 });
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Disable Artifact Builder skill"]')) &&
                document.body.innerText.includes("Injected")`,
              { timeoutMs: 30_000, label: "injected Artifact Builder skill enabled" },
            );
          },
          assert: async () => {
            await ctx.expectText("Artifact Builder skill");
            await ctx.expectText("Enabled for agents in this workspace.");
            await ctx.expectText("Injected");
            await ctx.expectText("Launch Radar");
          },
          screenshot: {
            name: "dynamic-artifact-builder-skill",
            requireText: ["Artifact Builder skill", "Injected", "Launch Radar"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2 — create and attach the project",
      run: async (ctx) => {
        await ctx.prove("A deterministic code-mode project is built and attached as a live React artifact in chat", {
          voiceover: vo[1],
          action: async () => {
            if (await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(STUDIO)}))`)) {
              await ctx.trustedClick('button[aria-label="UI Artifacts"]', {
                timeoutMs: 30_000,
              });
            }
            await ctx.navigateHash(state.sessionRoute);
            await ctx.waitFor(
              `window.__openworkControl.snapshot().route === ${JSON.stringify(state.sessionRoute)}`,
              { timeoutMs: 60_000, label: "seeded artifact session route" },
            );
            const attachment = await waitForReadyAttachment(ctx);
            state.projectRevision = attachment.projectRevision;
            state.stateRevision = attachment.stateRevision;
          },
          assert: async () => {
            const attachment = await readAttachment(ctx);
            ctx.assert(attachment.found, "The Launch Radar attachment was not rendered.");
            ctx.assert(attachment.frameState === "ready", `Expected a ready artifact frame, got ${attachment.frameState}.`);
            ctx.assert(attachment.text.includes("Launch Radar"), "The generated attachment does not identify Launch Radar.");
            ctx.assert(attachment.text.includes("Open editor"), "The generated attachment does not expose Open editor.");
            ctx.assert(
              typeof attachment.projectRevision === "string" && /^[a-f0-9]{64}$/.test(attachment.projectRevision),
              `The attachment is missing its immutable project revision: ${attachment.projectRevision}.`,
            );
          },
          screenshot: {
            name: "dynamic-artifact-inline",
            requireText: ["Launch Radar", "Open editor"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3 — prove the isolated renderer",
      run: async (ctx) => {
        await ctx.prove("The generated component runs in a ready opaque iframe with network and host authority denied", {
          voiceover: vo[2],
          assert: async () => {
            const attachment = await waitForReadyAttachment(ctx);
            const sandboxTokens = attachment.sandbox.split(/\s+/).filter(Boolean);
            ctx.assert(
              sandboxTokens.length === 1 && sandboxTokens[0] === "allow-scripts",
              `Expected an opaque allow-scripts-only sandbox, got ${JSON.stringify(attachment.sandbox)}.`,
            );
            ctx.assert(!sandboxTokens.includes("allow-same-origin"), "The artifact iframe was granted same-origin access.");
            ctx.assert(attachment.allow === "", `The artifact iframe exposes an allow policy: ${attachment.allow}.`);
            ctx.assert(
              attachment.referrerPolicy === "no-referrer",
              `Expected no-referrer, got ${JSON.stringify(attachment.referrerPolicy)}.`,
            );
            ctx.assert(
              /connect-src\s+'none'/.test(attachment.srcdoc),
              "The artifact iframe document does not deny network connections in its CSP.",
            );
            ctx.assert(attachment.frameState === "ready", "The isolated renderer did not reach ready.");
          },
          screenshot: {
            name: "dynamic-artifact-safe-render",
            requireText: ["Launch Radar"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4 — interact with persisted local state",
      run: async (ctx) => {
        await ctx.prove("A click inside the opaque component updates its bounded persisted state", {
          voiceover: vo[3],
          action: async () => {
            const before = await readAttachment(ctx);
            state.stateRevision = before.stateRevision;
            await ctx.trustedClick(FRAME);
            const changed = await ctx.waitFor(
              `(() => {
                const root = document.querySelector(${JSON.stringify(PROJECT_ROOT)});
                const revision = root?.getAttribute("data-ui-artifact-state-revision");
                const summary = root?.getAttribute("data-ui-artifact-state-summary");
                return revision &&
                  revision !== ${JSON.stringify(state.stateRevision)} &&
                  summary === "watching-apollo"
                  ? { revision, summary }
                  : null;
              })()`,
              { timeoutMs: 30_000, label: "persisted Launch Radar watch state" },
            );
            state.stateRevision = changed.revision;
          },
          assert: async () => {
            const attachment = await readAttachment(ctx);
            ctx.assert(
              attachment.stateSummary === "watching-apollo",
              `Expected watching-apollo state, got ${attachment.stateSummary}.`,
            );
            ctx.assert(
              attachment.stateRevision === state.stateRevision,
              "The attachment did not mirror the persisted state revision.",
            );
          },
          screenshot: {
            name: "dynamic-artifact-local-state",
            requireText: ["Launch Radar"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5 — open the reusable project",
      run: async (ctx) => {
        await ctx.prove("Open editor reveals a library and editor for the complete five-file artifact project", {
          voiceover: vo[4],
          action: async () => {
            await openStudioFromAttachment(ctx);
            await ctx.waitFor(
              `(() => {
                const studio = document.querySelector(${JSON.stringify(STUDIO)});
                const text = studio?.innerText ?? "";
                return ["artifact.json", "src/App.tsx", "styles.css", "data.json", "data.schema.json"]
                  .every((file) => text.includes(file));
              })()`,
              { timeoutMs: 30_000, label: "complete artifact project file list" },
            );
            await ctx.waitFor(
              `(() => {
                const studio = document.querySelector(${JSON.stringify(STUDIO)});
                const revision = studio?.querySelector("[data-ui-artifact-project-revision]")
                  ?.getAttribute("data-ui-artifact-project-revision");
                return studio?.innerText.includes("Launch Radar") &&
                  revision === ${JSON.stringify(state.projectRevision)};
              })()`,
              { timeoutMs: 30_000, label: "loaded Launch Radar project snapshot" },
            );
          },
          assert: async () => {
            const studio = await ctx.eval(`(() => {
              const root = document.querySelector(${JSON.stringify(STUDIO)});
              const text = root?.innerText ?? "";
              const revision = root?.querySelector("[data-ui-artifact-project-revision]")
                ?.getAttribute("data-ui-artifact-project-revision") ?? null;
              return {
                found: Boolean(root),
                hasLibrary: text.toLowerCase().includes("library"),
                hasEditor: text.toLowerCase().includes("editor"),
                hasTitle: text.includes("Launch Radar"),
                revision,
              };
            })()`);
            ctx.assert(studio.found, "The artifact studio did not open.");
            ctx.assert(studio.hasLibrary && studio.hasEditor, "The studio does not expose both Library and Editor.");
            ctx.assert(studio.hasTitle, "The studio did not retain the Launch Radar project.");
            ctx.assert(
              studio.revision === state.projectRevision,
              `Editor revision ${studio.revision} does not match chat revision ${state.projectRevision}.`,
            );
          },
          screenshot: {
            name: "dynamic-artifact-project-editor",
            requireText: ["LIBRARY", "EDITOR", "src/App.tsx", "data.schema.json"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6 — inspect source, contract, revision, and preview",
      run: async (ctx) => {
        await ctx.prove("The editor keeps React source, its data contract, immutable revision, and live preview together", {
          voiceover: vo[5],
          action: async () => {
            await ctx.clickText("src/App.tsx", { selector: `${STUDIO} button` });
            await ctx.waitFor(
              `(() => {
                const content = document.querySelector(${JSON.stringify(STUDIO)})?.querySelector(".cm-content");
                const text = content?.textContent ?? "";
                return text.includes("export default") && text.includes("Launch Radar");
              })()`,
              { timeoutMs: 30_000, label: "Launch Radar React source" },
            );
            await ctx.clickText("data.schema.json", { selector: `${STUDIO} button` });
            await ctx.waitFor(
              `(() => {
                const content = document.querySelector(${JSON.stringify(STUDIO)})?.querySelector(".cm-content");
                const text = content?.textContent ?? "";
                return text.includes("launches") && text.includes("type");
              })()`,
              { timeoutMs: 30_000, label: "Launch Radar data schema" },
            );
          },
          assert: async () => {
            const proof = await ctx.eval(`(() => {
              const studio = document.querySelector(${JSON.stringify(STUDIO)});
              const preview = studio?.querySelector("[data-ui-artifact-studio-preview]");
              const frame = preview?.querySelector("iframe");
              const revision = studio?.querySelector("[data-ui-artifact-project-revision]")
                ?.getAttribute("data-ui-artifact-project-revision") ?? null;
              const editorText = studio?.querySelector(".cm-content")?.textContent ?? "";
              return {
                hasPreview: Boolean(preview),
                hasPreviewFrame: Boolean(frame),
                schemaVisible: editorText.includes("launches") && editorText.includes("type"),
                revision,
              };
            })()`);
            ctx.assert(proof.hasPreview && proof.hasPreviewFrame, "The live preview is not mounted beside the editor.");
            ctx.assert(proof.schemaVisible, "The data contract is not visible in the source editor.");
            ctx.assert(
              proof.revision === state.projectRevision,
              `The visible revision changed unexpectedly from ${state.projectRevision} to ${proof.revision}.`,
            );
          },
          screenshot: {
            name: "dynamic-artifact-data-contract-preview",
            requireText: ["data.schema.json", "Revision"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7 — reload, reopen, and reuse",
      run: async (ctx) => {
        await ctx.prove("Reloading preserves the pinned build and local state, and the project reopens from the Artifacts library", {
          voiceover: vo[6],
          action: async () => {
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API after reload",
            });
            await ctx.waitFor(
              `window.__openworkControl.snapshot().route === ${JSON.stringify(state.sessionRoute)}`,
              { timeoutMs: 60_000, label: "same session after reload" },
            );
            await waitForReadyAttachment(ctx);
            await ctx.waitFor(
              `(() => {
                const root = document.querySelector(${JSON.stringify(PROJECT_ROOT)});
                return root?.getAttribute("data-ui-artifact-project-revision") === ${JSON.stringify(state.projectRevision)} &&
                  root?.getAttribute("data-ui-artifact-state-revision") === ${JSON.stringify(state.stateRevision)} &&
                  root?.getAttribute("data-ui-artifact-state-summary") === "watching-apollo";
              })()`,
              { timeoutMs: 30_000, label: "pinned project and state restored after reload" },
            );
            await ctx.trustedClick('button[aria-label="UI Artifacts"]', {
              timeoutMs: 30_000,
            });
            await ctx.waitForText("Launch Radar", { timeoutMs: 30_000 });
            await ctx.clickText("Launch Radar", {
              selector: 'button, [role="button"]',
              timeoutMs: 30_000,
            });
            await ctx.waitFor(
              `(() => {
                const studio = document.querySelector(${JSON.stringify(STUDIO)});
                const revision = studio?.querySelector("[data-ui-artifact-project-revision]")
                  ?.getAttribute("data-ui-artifact-project-revision");
                return revision === ${JSON.stringify(state.projectRevision)};
              })()`,
              { timeoutMs: 30_000, label: "same artifact revision reopened from library" },
            );
          },
          assert: async () => {
            const attachment = await readAttachment(ctx);
            ctx.assert(
              attachment.projectRevision === state.projectRevision,
              "Reload changed the pinned project revision.",
            );
            ctx.assert(
              attachment.stateRevision === state.stateRevision &&
                attachment.stateSummary === "watching-apollo",
              "Reload did not restore the persisted local interaction state.",
            );
            await ctx.expectText("Launch Radar");
            await ctx.expectText("src/App.tsx");
          },
          screenshot: {
            name: "dynamic-artifact-persisted-reopened",
            requireText: ["Launch Radar", "src/App.tsx", "Revision"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 8 — disable new builds without breaking pinned work",
      run: async (ctx) => {
        await ctx.prove("A project can be disabled from the library while its editor and immutable pinned preview remain available", {
          voiceover: vo[7],
          action: async () => {
            await ctx.trustedClick('button[aria-label="Back to generated projects"]', {
              timeoutMs: 30_000,
            });
            await ctx.waitForText("Artifact Builder skill", { timeoutMs: 30_000 });
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Disable Launch Radar"]'))`,
              { timeoutMs: 30_000, label: "enabled Launch Radar project switch" },
            );
            await ctx.trustedClick('[aria-label="Disable Launch Radar"]', {
              timeoutMs: 30_000,
            });
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Enable Launch Radar"]'))`,
              { timeoutMs: 30_000, label: "disabled Launch Radar project switch" },
            );
            await ctx.clickText("Launch Radar", {
              selector: 'button, [role="button"]',
              timeoutMs: 30_000,
            });
            await ctx.waitFor(
              `(() => {
                const studio = document.querySelector(${JSON.stringify(STUDIO)});
                const text = studio?.innerText ?? "";
                const rebuild = Array.from(studio?.querySelectorAll("button") ?? [])
                  .find((button) => button.textContent?.includes("Rebuild"));
                const preview = studio?.querySelector("[data-ui-artifact-studio-preview] iframe");
                return text.includes("Disabled · editing only") &&
                  rebuild?.disabled === true &&
                  Boolean(preview);
              })()`,
              { timeoutMs: 30_000, label: "disabled editable artifact with pinned preview" },
            );
          },
          assert: async () => {
            const lifecycle = await ctx.eval(`(() => {
              const studio = document.querySelector(${JSON.stringify(STUDIO)});
              const text = studio?.innerText ?? "";
              const rebuild = Array.from(studio?.querySelectorAll("button") ?? [])
                .find((button) => button.textContent?.includes("Rebuild"));
              return {
                disabled: text.includes("Disabled · editing only"),
                rebuildDisabled: rebuild?.disabled === true,
                previewPresent: Boolean(
                  studio?.querySelector("[data-ui-artifact-studio-preview] iframe")
                ),
                revision: studio?.querySelector("[data-ui-artifact-project-revision]")
                  ?.getAttribute("data-ui-artifact-project-revision") ?? null,
              };
            })()`);
            ctx.assert(lifecycle.disabled, "The project does not show its disabled lifecycle state.");
            ctx.assert(lifecycle.rebuildDisabled, "A disabled project still allows new builds.");
            ctx.assert(lifecycle.previewPresent, "Disabling the project removed its immutable preview.");
            ctx.assert(
              lifecycle.revision === state.projectRevision,
              "Disabling the project changed its pinned revision.",
            );
          },
          screenshot: {
            name: "dynamic-artifact-disabled-editable",
            requireText: ["Launch Radar", "Disabled", "Rebuild", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 9 — start a human-created artifact",
      run: async (ctx) => {
        await ctx.prove("The same managed library gives a person a clear create flow with an explicit reusable-project identity", {
          voiceover: vo[8],
          action: async () => {
            await openArtifactLibrary(ctx);
            await ctx.clickText("Create artifact", {
              selector: `${STUDIO} button`,
              timeoutMs: 30_000,
            });
            await ctx.waitForText("Create an artifact", { timeoutMs: 30_000 });
            await ctx.fill('[role="dialog"] input[placeholder="Project pulse"]', "Incident Command Map");
            await ctx.fill(
              '[role="dialog"] input[placeholder="Show the status and next steps for my project"]',
              "Coordinate owners, severity, evidence, and the next safe action.",
            );
            await ctx.waitForText("Workspace project: incident-command-map", {
              timeoutMs: 30_000,
            });
          },
          assert: async () => {
            const dialog = await ctx.eval(`(() => {
              const root = document.querySelector('[role="dialog"]');
              const text = root?.innerText ?? "";
              const create = [...(root?.querySelectorAll("button") ?? [])]
                .find((button) => button.textContent?.includes("Create and edit"));
              return {
                found: Boolean(root),
                hasName: text.includes("Name"),
                hasPurpose: text.includes("What should it help with?"),
                slug: text.includes("incident-command-map"),
                canCreate: create?.disabled === false,
              };
            })()`);
            ctx.assert(dialog.found, "The human artifact creation dialog did not open.");
            ctx.assert(dialog.hasName && dialog.hasPurpose, "The creation flow is missing its name or purpose contract.");
            ctx.assert(dialog.slug, "The creation flow did not expose the durable workspace slug.");
            ctx.assert(dialog.canCreate, "A valid artifact draft cannot be created.");
          },
          screenshot: {
            name: "dynamic-artifact-create-dialog",
            requireText: ["Create an artifact", "What should it help with?", "incident-command-map", "Create and edit"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 10 — restore agent authoring and project builds",
      run: async (ctx) => {
        await ctx.prove("Workspace skill and per-project switches are independent, visible controls rather than hidden agent configuration", {
          voiceover: vo[9],
          action: async () => {
            await ctx.clickText("Close", {
              selector: '[role="dialog"] button',
              timeoutMs: 30_000,
            });
            await ctx.waitFor(
              `!document.querySelector('[role="dialog"]')`,
              { timeoutMs: 30_000, label: "artifact creation dialog closed" },
            );
            if (await ctx.eval(`Boolean(document.querySelector('[aria-label="Enable Artifact Builder skill"]'))`)) {
              await ctx.trustedClick('[aria-label="Enable Artifact Builder skill"]', {
                timeoutMs: 30_000,
              });
            }
            if (await ctx.eval(`Boolean(document.querySelector('[aria-label="Enable Launch Radar"]'))`)) {
              await ctx.trustedClick('[aria-label="Enable Launch Radar"]', {
                timeoutMs: 30_000,
              });
            }
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Disable Artifact Builder skill"]')) &&
                Boolean(document.querySelector('[aria-label="Disable Launch Radar"]')) &&
                document.body.innerText.includes("Injected")`,
              { timeoutMs: 30_000, label: "workspace skill and Launch Radar both enabled" },
            );
          },
          assert: async () => {
            await ctx.expectText("Artifact Builder skill");
            await ctx.expectText("Injected");
            await ctx.expectText("Launch Radar");
            const controls = await ctx.eval(`({
              skillEnabled: Boolean(document.querySelector('[aria-label="Disable Artifact Builder skill"]')),
              projectEnabled: Boolean(document.querySelector('[aria-label="Disable Launch Radar"]')),
            })`);
            ctx.assert(controls.skillEnabled, "The managed Artifact Builder skill is not enabled.");
            ctx.assert(controls.projectEnabled, "Launch Radar is not enabled for new revisions.");
          },
          screenshot: {
            name: "dynamic-artifact-managed-controls",
            requireText: ["Artifact Builder skill", "Injected", "Launch Radar", "Enabled"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 11 — stage a bounded agent intent",
      run: async (ctx) => {
        await ctx.prove("A component can request in-context help, but the bridge only stages a declared prompt and never executes tools or effects itself", {
          voiceover: vo[10],
          action: async () => {
            await closeArtifactPanel(ctx);
            await ctx.navigateHash(state.sessionRoute);
            await waitForReadyAttachment(ctx);
            await clickArtifactButton(ctx, "Ask agent about launch risk");
            await ctx.waitFor(
              `(() => {
                const editable = document.querySelector('[contenteditable="true"]');
                const text = editable?.textContent ?? "";
                return text.includes("Stage this OpenWork artifact intent for the agent") &&
                  text.includes("Intent: Explain launch risk (launch.explain)") &&
                  text.includes("Do not execute tools or external effects automatically.");
              })()`,
              { timeoutMs: 30_000, label: "prompt-only artifact intent staged in composer" },
            );
          },
          assert: async () => {
            const composer = await ctx.eval(`document.querySelector('[contenteditable="true"]')?.textContent ?? ""`);
            ctx.assert(
              composer.includes("Intent: Explain launch risk (launch.explain)"),
              "The declared launch.explain intent was not staged.",
            );
            ctx.assert(
              composer.includes('"external":false'),
              "The staged prompt does not preserve the declared no-external-effect contract.",
            );
            ctx.assert(
              composer.includes("Confirmation policy: never"),
              "The staged prompt does not preserve the manifest confirmation policy.",
            );
          },
          screenshot: {
            name: "dynamic-artifact-agent-intent",
            requireText: [
              "Stage this OpenWork artifact intent for the agent",
              "Intent: Explain launch risk",
            ],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 12 — inspect the versioned manifest",
      run: async (ctx) => {
        await ctx.prove("artifact.json is the explicit contract for protocol version, React entrypoint, data, presentation, declared intents, and effects", {
          voiceover: vo[11],
          action: async () => {
            await ctx.control("composer.set_text", { text: "" });
            await ctx.waitFor(
              `!(document.querySelector('[contenteditable="true"]')?.textContent ?? "").trim()`,
              { timeoutMs: 30_000, label: "composer cleared after intent proof" },
            );
            await openStudioFromAttachment(ctx);
            await selectProjectFile(ctx, "artifact.json");
            await ctx.waitFor(
              `(() => {
                const text = window.__artifactEditorView?.state?.doc?.toString() ?? "";
                return text.includes('"protocol": "openwork.ui-artifact-project"') &&
                  text.includes('"schemaVersion": 2') &&
                  text.includes('"launch.explain"') &&
                  text.includes('"external": false');
              })()`,
              { timeoutMs: 30_000, label: "complete artifact manifest contract" },
            );
          },
          assert: async () => {
            const manifest = JSON.parse(await readEditorText(ctx));
            ctx.assert(manifest.protocol === "openwork.ui-artifact-project", "The project protocol is not explicit.");
            ctx.assert(manifest.schemaVersion === 2 && manifest.apiVersion === 1, "The manifest versions are not pinned.");
            ctx.assert(manifest.runtime?.kind === "react", "The runtime does not declare React.");
            ctx.assert(manifest.presentation?.placement === "both", "The manifest does not support chat and artifact-tab placement.");
            ctx.assert(manifest.intents?.[0]?.effects?.external === false, "The declared intent permits external effects.");
          },
          screenshot: {
            name: "dynamic-artifact-manifest-contract",
            requireText: ["artifact.json", "Revision", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 13 — inspect the generated React component",
      run: async (ctx) => {
        await ctx.prove("The primary file is ordinary typed JSX with injected data, bounded state, and a narrow runtime adapter", {
          voiceover: vo[12],
          action: async () => {
            await selectProjectFile(ctx, "src/App.tsx");
            state.originalSource = await readEditorText(ctx);
            await ctx.waitFor(
              `(() => {
                const text = window.__artifactEditorView?.state?.doc?.toString() ?? "";
                return text.includes("export default function LaunchRadar") &&
                  text.includes("runtime.replaceState") &&
                  text.includes('runtime.invoke("launch.explain"');
              })()`,
              { timeoutMs: 30_000, label: "typed React component and bounded runtime calls" },
            );
          },
          assert: async () => {
            const source = await readEditorText(ctx);
            ctx.assert(source.includes("type LaunchRadarProps"), "The generated component does not type its injected contract.");
            ctx.assert(source.includes("runtime.replaceState"), "The component cannot use bounded local state.");
            ctx.assert(source.includes('runtime.invoke("launch.explain"'), "The component cannot invoke its declared agent intent.");
            ctx.assert(!source.includes("fetch("), "The generated source attempts direct network access.");
          },
          screenshot: {
            name: "dynamic-artifact-react-source",
            requireText: ["src/App.tsx", "Revision", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 14 — inspect presentation as a separate file",
      run: async (ctx) => {
        await ctx.prove("Visual expression lives in styles.css, independently editable from the component, contract, and data", {
          voiceover: vo[13],
          action: async () => {
            await selectProjectFile(ctx, "styles.css");
            await ctx.waitFor(
              `(() => {
                const text = window.__artifactEditorView?.state?.doc?.toString() ?? "";
                return text.includes(".launch-radar") &&
                  text.includes(".watch-button") &&
                  text.includes(".agent-button");
              })()`,
              { timeoutMs: 30_000, label: "artifact presentation stylesheet" },
            );
          },
          assert: async () => {
            const styles = await readEditorText(ctx);
            ctx.assert(styles.includes("radial-gradient"), "The expressive visual treatment is not present.");
            ctx.assert(styles.includes(".launch-grid"), "The artifact layout is not independently styled.");
            ctx.assert(styles.includes(".agent-button"), "The in-context agent affordance has no presentation rule.");
          },
          screenshot: {
            name: "dynamic-artifact-styles",
            requireText: ["styles.css", "Revision", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 15 — inspect portable artifact data",
      run: async (ctx) => {
        await ctx.prove("data.json makes the rendered values portable, inspectable, and separately enhanceable without rewriting JSX", {
          voiceover: vo[14],
          action: async () => {
            await selectProjectFile(ctx, "data.json");
            await ctx.waitFor(
              `(() => {
                const text = window.__artifactEditorView?.state?.doc?.toString() ?? "";
                return text.includes('"launches"') &&
                  text.includes('"Apollo"') &&
                  text.includes('"readiness": 94');
              })()`,
              { timeoutMs: 30_000, label: "portable Launch Radar data" },
            );
          },
          assert: async () => {
            const data = JSON.parse(await readEditorText(ctx));
            ctx.assert(Array.isArray(data.launches) && data.launches.length >= 3, "The artifact data is not a reusable launch collection.");
            ctx.assert(data.launches[0]?.name === "Apollo", "The primary launch data is not preserved.");
            ctx.assert(data.launches[0]?.readiness === 94, "The original readiness value is not pinned.");
          },
          screenshot: {
            name: "dynamic-artifact-data",
            requireText: ["data.json", "Revision", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 16 — inspect the JSON Schema boundary",
      run: async (ctx) => {
        await ctx.prove("data.schema.json is the build-time data contract, keeping generated components honest before they ever reach the iframe", {
          voiceover: vo[15],
          action: async () => {
            await selectProjectFile(ctx, "data.schema.json");
            await ctx.waitFor(
              `(() => {
                const text = window.__artifactEditorView?.state?.doc?.toString() ?? "";
                return text.includes('"type": "object"') &&
                  text.includes('"required"') &&
                  text.includes('"launches"');
              })()`,
              { timeoutMs: 30_000, label: "artifact JSON Schema contract" },
            );
          },
          assert: async () => {
            const schema = JSON.parse(await readEditorText(ctx));
            ctx.assert(schema.type === "object", "The artifact data root is not constrained.");
            ctx.assert(schema.required?.includes("launches"), "The launch collection is not required.");
            ctx.assert(schema.properties?.launches?.type === "array", "The launch collection type is not declared.");
            ctx.assert(schema.additionalProperties === false, "The root contract accepts undeclared data.");
          },
          screenshot: {
            name: "dynamic-artifact-json-schema",
            requireText: ["data.schema.json", "Revision", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 17 — reject unsafe generated code",
      run: async (ctx) => {
        await ctx.prove("The code-mode compiler returns a structured diagnostic instead of publishing an obviously unbounded component", {
          voiceover: vo[16],
          action: async () => {
            await selectProjectFile(ctx, "src/App.tsx");
            await replaceEditorText(
              ctx,
              "export default function BrokenArtifact() { while (true) {} return <main>Broken</main> }\n",
            );
            await ctx.clickText("Rebuild", {
              selector: `${STUDIO} button`,
              timeoutMs: 30_000,
            });
            await ctx.waitForText(
              "Potentially unbounded loops are not supported inside artifact components",
              { timeoutMs: 60_000 },
            );
          },
          assert: async () => {
            await ctx.expectText("Artifact component could not be compiled");
            await ctx.expectText("Potentially unbounded loops are not supported inside artifact components");
            const diagnostic = await ctx.eval(`(() => {
              const list = document.querySelector('[aria-label="Artifact build diagnostics"]');
              return {
                found: Boolean(list),
                text: list?.innerText ?? "",
                hasPreview: Boolean(
                  document.querySelector(${JSON.stringify(`${STUDIO} [data-ui-artifact-studio-preview] iframe`)})
                ),
              };
            })()`);
            ctx.assert(diagnostic.found, "The compiler failure did not expose structured diagnostics.");
            ctx.assert(
              diagnostic.text.includes("line 1") && diagnostic.text.includes("column 44"),
              "The diagnostic does not identify the failing source location.",
            );
            ctx.assert(diagnostic.hasPreview, "A failed rebuild removed the last known-good preview.");
          },
          screenshot: {
            name: "dynamic-artifact-compiler-diagnostic",
            requireText: ["Artifact component could not be compiled", "Potentially unbounded loops", "Live sandbox preview"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 18 — publish an enhanced immutable revision",
      run: async (ctx) => {
        await ctx.prove("Restoring safe source and changing only data publishes a new immutable build while keeping its compiler receipt visible", {
          voiceover: vo[17],
          action: async () => {
            ctx.assert(typeof state.originalSource === "string", "The original Launch Radar source was not captured.");
            await replaceEditorText(ctx, state.originalSource);
            await selectProjectFile(ctx, "data.json");
            const dataText = await readEditorText(ctx);
            ctx.assert(dataText.includes('"readiness": 94'), "The expected original readiness value is unavailable.");
            await replaceEditorText(ctx, dataText.replace('"readiness": 94', '"readiness": 97'));
            await ctx.clickText("Rebuild", {
              selector: `${STUDIO} button`,
              timeoutMs: 30_000,
            });
            await ctx.waitForText("Build ready:", { timeoutMs: 60_000 });
            state.enhancedProjectRevision = await ctx.waitFor(
              `(() => {
                const revision = document.querySelector(${JSON.stringify(`${STUDIO} [data-ui-artifact-project-revision]`)})
                  ?.getAttribute("data-ui-artifact-project-revision");
                return revision && revision !== ${JSON.stringify(state.projectRevision)}
                  ? revision
                  : null;
              })()`,
              { timeoutMs: 30_000, label: "new immutable Launch Radar revision" },
            );
          },
          assert: async () => {
            const proof = await ctx.eval(`(() => {
              const studio = document.querySelector(${JSON.stringify(STUDIO)});
              return {
                revision: studio?.querySelector("[data-ui-artifact-project-revision]")
                  ?.getAttribute("data-ui-artifact-project-revision") ?? null,
                diagnostic: studio?.innerText.includes("Build ready:") ?? false,
                preview: Boolean(studio?.querySelector("[data-ui-artifact-studio-preview] iframe")),
              };
            })()`);
            ctx.assert(proof.revision === state.enhancedProjectRevision, "The editor did not advance to the enhanced revision.");
            ctx.assert(proof.revision !== state.projectRevision, "The enhanced build replaced the original revision identity.");
            ctx.assert(proof.diagnostic, "The successful compiler receipt is not visible.");
            ctx.assert(proof.preview, "The enhanced build has no live isolated preview.");
          },
          screenshot: {
            name: "dynamic-artifact-enhanced-revision",
            requireText: ["Build ready:", "data.json", "Revision", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 19 — keep chat pinned to its original build",
      run: async (ctx) => {
        await ctx.prove("Evolving the reusable project never silently mutates an artifact already attached to a conversation", {
          voiceover: vo[18],
          action: async () => {
            await closeArtifactPanel(ctx);
            await ctx.navigateHash(state.sessionRoute);
            await waitForReadyAttachment(ctx);
          },
          assert: async () => {
            const attachment = await readAttachment(ctx);
            ctx.assert(
              attachment.projectRevision === state.projectRevision,
              `The chat attachment silently moved from ${state.projectRevision} to ${attachment.projectRevision}.`,
            );
            ctx.assert(
              attachment.projectRevision !== state.enhancedProjectRevision,
              "The original chat card was silently upgraded to the new project revision.",
            );
            ctx.assert(
              attachment.stateRevision === state.stateRevision &&
                attachment.stateSummary === "watching-apollo",
              "The pinned chat card lost its independent persisted interaction state.",
            );
          },
          screenshot: {
            name: "dynamic-artifact-chat-stays-pinned",
            requireText: ["Launch Radar", "Open editor"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 20 — disable the enhanced project safely",
      run: async (ctx) => {
        await ctx.prove("Disabling a project blocks future publication but preserves the enhanced source, exact revision, and last known-good preview", {
          voiceover: vo[19],
          action: async () => {
            await openArtifactLibrary(ctx);
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Disable Launch Radar"]'))`,
              { timeoutMs: 30_000, label: "enabled enhanced Launch Radar project" },
            );
            await ctx.trustedClick('[aria-label="Disable Launch Radar"]', {
              timeoutMs: 30_000,
            });
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Enable Launch Radar"]'))`,
              { timeoutMs: 30_000, label: "enhanced Launch Radar disabled" },
            );
            await ctx.clickText("Launch Radar", {
              selector: '[data-ui-artifact-library-project="launch-radar"] button',
              timeoutMs: 30_000,
            });
            await ctx.waitFor(
              `(() => {
                const studio = document.querySelector(${JSON.stringify(STUDIO)});
                const revision = studio?.querySelector("[data-ui-artifact-project-revision]")
                  ?.getAttribute("data-ui-artifact-project-revision");
                const rebuild = [...(studio?.querySelectorAll("button") ?? [])]
                  .find((button) => button.textContent?.includes("Rebuild"));
                return revision === ${JSON.stringify(state.enhancedProjectRevision)} &&
                  studio?.innerText.includes("Disabled · editing only") &&
                  rebuild?.disabled === true &&
                  Boolean(studio?.querySelector("[data-ui-artifact-studio-preview] iframe"));
              })()`,
              { timeoutMs: 30_000, label: "disabled enhanced project remains editable and previewable" },
            );
          },
          assert: async () => {
            const revision = await ctx.eval(
              `document.querySelector(${JSON.stringify(`${STUDIO} [data-ui-artifact-project-revision]`)})
                ?.getAttribute("data-ui-artifact-project-revision") ?? null`,
            );
            ctx.assert(revision === state.enhancedProjectRevision, "Disabling changed the enhanced revision.");
            await ctx.expectText("Disabled · editing only");
            await ctx.expectText("Live sandbox preview");
          },
          screenshot: {
            name: "dynamic-artifact-enhanced-disabled",
            requireText: ["Launch Radar", "Disabled", "Rebuild", "Live sandbox preview"],
            rejectText: ["Artifact unavailable", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 21 — disable injected authoring without deleting work",
      run: async (ctx) => {
        await ctx.prove("The workspace can remove injected builder instructions while its reusable projects remain listed and pinned artifacts keep working", {
          voiceover: vo[20],
          action: async () => {
            await openArtifactLibrary(ctx);
            if (await ctx.eval(`Boolean(document.querySelector('[aria-label="Disable Artifact Builder skill"]'))`)) {
              await ctx.trustedClick('[aria-label="Disable Artifact Builder skill"]', {
                timeoutMs: 30_000,
              });
            }
            await ctx.waitFor(
              `Boolean(document.querySelector('[aria-label="Enable Artifact Builder skill"]')) &&
                document.body.innerText.includes("Managed") &&
                document.body.innerText.includes("Launch Radar")`,
              { timeoutMs: 30_000, label: "builder skill disabled with project retained" },
            );
          },
          assert: async () => {
            await ctx.expectText("Disabled. Existing pinned artifacts still work");
            await ctx.expectText("Managed");
            await ctx.expectText("Launch Radar");
            const retained = await ctx.eval(`Boolean(
              document.querySelector('[data-ui-artifact-library-project="launch-radar"]')
            )`);
            ctx.assert(retained, "Disabling injected authoring removed the reusable project.");
          },
          screenshot: {
            name: "dynamic-artifact-builder-disabled-retained",
            requireText: ["Artifact Builder skill", "Managed", "Launch Radar", "Disabled"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 22 — coexist with standard native artifacts",
      run: async (ctx) => {
        await ctx.prove("Generated React projects and validated standard answer cards remain separate catalogs with independent lifecycle controls", {
          voiceover: vo[21],
          action: async () => {
            await ctx.clickText("Standard", {
              selector: '[role="tab"]',
              timeoutMs: 30_000,
            });
            await ctx.waitForText("Native answer prototypes", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const text = await ctx.eval(`document.querySelector('[aria-label="UI artifacts"]')?.innerText ?? ""`);
            for (const label of [
              "Workspace brief",
              "Calendar",
              "Widgets",
              "Conversation thread",
              "Priority inbox",
              "Attention queue",
              "Approval queue",
            ]) {
              ctx.assert(text.includes(label), `The standard catalog is missing ${label}.`);
            }
            const standardSelected = await ctx.eval(`(() => {
              const tab = [...document.querySelectorAll('[role="tab"]')]
                .find((item) => item.textContent?.trim() === "Standard");
              return tab?.getAttribute("aria-selected") === "true";
            })()`);
            ctx.assert(standardSelected, "The standard artifact catalog is not selected.");
          },
          screenshot: {
            name: "dynamic-artifact-standard-coexistence",
            requireText: ["Native answer prototypes", "Workspace brief", "Calendar", "Widgets"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 23 — keep artifact preferences usable without cloud",
      run: async (ctx) => {
        await ctx.prove("The master artifact switch persists locally when signed out and continues to synchronize with an organization when signed in", {
          voiceover: vo[22],
          action: async () => {
            await ctx.navigateHash("/settings/preferences");
            await ctx.waitForText("UI artifacts (Alpha)", { timeoutMs: 30_000 });
            const selector = '[role="switch"][aria-label="UI artifacts (Alpha)"]';
            const signedOut = await ctx.eval(`(
              !localStorage.getItem("openwork.den.authToken") &&
              !localStorage.getItem("openwork.den.activeOrgId")
            )`);
            ctx.assert(signedOut, "This local-preference proof requires a signed-out workspace.");

            if (await ctx.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-checked") === "true"`)) {
              await ctx.trustedClick(selector, { timeoutMs: 30_000 });
              await ctx.waitFor(
                `document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-checked") === "false"`,
                { timeoutMs: 30_000, label: "UI artifacts disabled locally" },
              );
            }
            await ctx.trustedClick(selector, { timeoutMs: 30_000 });
            await ctx.waitFor(
              `(() => {
                const raw = localStorage.getItem("openwork.preferences");
                const prefs = raw ? JSON.parse(raw) : {};
                return document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-checked") === "true" &&
                  prefs.featureFlags?.uiArtifacts === true;
              })()`,
              { timeoutMs: 30_000, label: "UI artifacts enabled in local preferences" },
            );

            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API after preference reload",
            });
            await ctx.navigateHash(state.sessionRoute);
            await ctx.waitFor(
              `window.__openworkControl.snapshot().route === ${JSON.stringify(state.sessionRoute)}`,
              { timeoutMs: 60_000, label: "stable workspace session after preference reload" },
            );
            await waitForReadyAttachment(ctx);
            await ctx.navigateHash("/settings/preferences");
            await ctx.waitForText("UI artifacts (Alpha)", { timeoutMs: 30_000 });
            await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                return window.__openworkControl.snapshot().route.includes("/settings/preferences") &&
                  document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-checked") === "true" &&
                  !text.includes("Preparing workspace") &&
                  !text.includes("Failed to fetch");
              })()`,
              { timeoutMs: 60_000, label: "local UI artifact preference restored in stable settings after reload" },
            );
            await ctx.eval(`document.querySelector(${JSON.stringify(selector)})
              ?.scrollIntoView({ block: "center", inline: "nearest" })`);
          },
          assert: async () => {
            const proof = await ctx.eval(`(() => {
              const raw = localStorage.getItem("openwork.preferences");
              const prefs = raw ? JSON.parse(raw) : {};
              return {
                checked: document.querySelector('[role="switch"][aria-label="UI artifacts (Alpha)"]')
                  ?.getAttribute("aria-checked") === "true",
                stored: prefs.featureFlags?.uiArtifacts === true,
                signedOut: !localStorage.getItem("openwork.den.authToken") &&
                  !localStorage.getItem("openwork.den.activeOrgId"),
              };
            })()`);
            ctx.assert(proof.signedOut, "The workspace is no longer signed out.");
            ctx.assert(proof.checked, "The master UI artifacts switch did not remain enabled.");
            ctx.assert(proof.stored, "The enabled state was not saved in local preferences.");
            await ctx.expectText("saved on this device otherwise");
            await ctx.expectText("Workspace brief");
          },
          screenshot: {
            name: "dynamic-artifact-local-preference",
            requireText: [
              "UI artifacts (Alpha)",
              "saved on this device otherwise",
              "Workspace brief",
            ],
            rejectText: ["Something went wrong", "Failed to fetch", "Preparing workspace"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
  ],
};
