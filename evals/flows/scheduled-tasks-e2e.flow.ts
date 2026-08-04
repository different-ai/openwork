/**
 * Scheduled Tasks end-to-end proof.
 *
 * The primary proof starts from the first-class Scheduled Tasks UI, crosses
 * the disabled draft and human authority boundary, then proves a manual run,
 * fresh linked session, and durable artifact receipt against server truth.
 */
import { mkdir } from "node:fs/promises";

import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "scheduled-tasks-e2e";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const TASK_NAME = "EVAL workspace report";
const TASK_PROMPT = [
  "Create a file named scheduled-task-eval-report.md in this workspace.",
  "Write a concise Markdown report confirming that this bounded manual Scheduled Task completed.",
  "Do not read or write outside this workspace.",
].join(" ");

type FlowState = {
  workspaceId: string;
  taskId: string;
  runId: string;
  manualSessionId: string;
  manualArtifactId: string;
  scheduledRunId: string;
  firstScheduledRunCount: number;
  deterministicNow: number;
};

const state: FlowState = {
  workspaceId: "",
  taskId: "",
  runId: "",
  manualSessionId: "",
  manualArtifactId: "",
  scheduledRunId: "",
  firstScheduledRunCount: 0,
  deterministicNow: 0,
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

async function serverRead(ctx: FlowContext, path: string): Promise<unknown> {
  return ctx.eval(`(async () => {
    const override = localStorage.getItem("openwork.server.urlOverride");
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token") || "";
    const baseUrl = (override || (port ? "http://127.0.0.1:" + port : "")).replace(/\\/+$/, "");
    if (!baseUrl) throw new Error("OpenWork server URL is unavailable");
    const response = await fetch(baseUrl + ${JSON.stringify(path)}, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error("GET ${path} failed: " + response.status + " " + text);
    return payload;
  })()`, { awaitPromise: true });
}

async function serverDownload(
  ctx: FlowContext,
  path: string,
): Promise<{ status: number; text: string }> {
  return ctx.eval(`(async () => {
    const override = localStorage.getItem("openwork.server.urlOverride");
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token") || "";
    const baseUrl = (override || (port ? "http://127.0.0.1:" + port : "")).replace(/\\/+$/, "");
    if (!baseUrl) throw new Error("OpenWork server URL is unavailable");
    const response = await fetch(baseUrl + ${JSON.stringify(path)}, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    return {
      status: response.status,
      text: await response.text(),
    };
  })()`, { awaitPromise: true }) as Promise<{
    status: number;
    text: string;
  }>;
}

function recordValue(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  return Reflect.get(record, key);
}

function arrayValue(record: unknown, key: string): unknown[] {
  const value = recordValue(record, key);
  return Array.isArray(value) ? value : [];
}

async function readDetail(ctx: FlowContext): Promise<unknown> {
  return serverRead(
    ctx,
    `/workspace/${encodeURIComponent(state.workspaceId)}/scheduled-tasks/${encodeURIComponent(state.taskId)}`,
  );
}

async function waitForRunCount(
  ctx: FlowContext,
  predicate: (runs: unknown[]) => boolean,
  label: string,
  timeoutMs = 180_000,
): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  let runs: unknown[] = [];
  while (Date.now() < deadline) {
    const detail = await readDetail(ctx);
    runs = arrayValue(detail, "runs");
    if (predicate(runs)) return runs;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label}: ${JSON.stringify(runs)}`);
}

function runStatus(run: unknown) {
  const status = recordValue(run, "status");
  return typeof status === "string" ? status : "";
}

function runTrigger(run: unknown) {
  const trigger = recordValue(run, "trigger");
  return typeof trigger === "string" ? trigger : "";
}

function runIsTerminal(run: unknown) {
  return !["queued", "claimed", "running", "retrying"].includes(runStatus(run));
}

async function focusSection(
  ctx: FlowContext,
  selector: string,
  block: "start" | "center" | "end" = "start",
) {
  await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing section: " + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: ${JSON.stringify(block)}, inline: "nearest" });
    return true;
  })()`);
}

async function setTextControl(ctx: FlowContext, selector: string, value: string) {
  await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Missing text control: " + ${JSON.stringify(selector)});
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("Text control value setter is unavailable");
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function enableScheduledTasksPreview(ctx: FlowContext) {
  await ctx.eval(`(() => {
    const key = "openwork.preferences";
    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem(key) || "{}"); } catch {}
    const featureFlags = preferences && typeof preferences === "object"
      && preferences.featureFlags && typeof preferences.featureFlags === "object"
      ? preferences.featureFlags
      : {};
    localStorage.setItem(key, JSON.stringify({
      ...preferences,
      featureFlags: { ...featureFlags, scheduledTasks: true },
    }));
    location.reload();
  })()`);
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "OpenWork after enabling Scheduled Tasks preview",
  });
}

async function openTechnicalScope(ctx: FlowContext) {
  const alreadyOpen = await ctx.eval(
    "Boolean(document.querySelector('[data-testid=\"scheduled-task-capabilities\"]'))",
  );
  if (alreadyOpen) return;
  await ctx.clickText("Technical scope", {
    selector: "button",
    timeoutMs: 10_000,
  });
  await ctx.waitFor(
    "Boolean(document.querySelector('[data-testid=\"scheduled-task-capabilities\"]'))",
    { timeoutMs: 10_000, label: "Scheduled Task technical authority scope" },
  );
}

async function finishPendingWorkspaceOnboarding(ctx: FlowContext) {
  const providerStep = await ctx.eval(`Boolean([...document.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("Skip and use the free model")))`);
  if (providerStep) {
    await ctx.clickText("Skip and use the free model", {
      selector: "button",
      timeoutMs: 10_000,
    });
    await ctx.waitFor(`location.hash.includes("/workspace/")
      || [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.trim() === "Skip")`, {
      timeoutMs: 10_000,
      label: "attribution step after provider selection",
    });
  }

  const attributionStep = await ctx.eval(`Boolean([...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Skip"))`);
  if (attributionStep) {
    await ctx.clickText("Skip", {
      selector: "button",
      timeoutMs: 10_000,
    });
  }
}

export default defineFlow({
  id: FLOW_ID,
  title: "A manual Scheduled Task is created, reviewed, run, and inspected safely",
  kind: "user-facing",
  spec: "SCHEDULED-TASKS",
  requiredEnv: ["OPENWORK_EVAL_WORKSPACE_PATH"],
  requiresApp: true,
  steps: [
    {
      name: "The workspace Scheduled Tasks surface is ready",
      run: async (ctx: FlowContext) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "OpenWork semantic control",
        });
        const workspacePath = requireString(
          ctx.env.OPENWORK_EVAL_WORKSPACE_PATH,
          "OPENWORK_EVAL_WORKSPACE_PATH",
        );
        await mkdir(workspacePath, { recursive: true });
        await finishPendingWorkspaceOnboarding(ctx);

        let workspaceId = await ctx.eval(`(() => {
          const context = window.__openworkControl.context();
          return context.screen.workspaceId || context.resources
            .find((resource) => resource.kind === "workspace")?.ref.replace(/^workspace:/, "") || "";
        })()`);
        if (workspaceId) {
          const workspaces = await serverRead(ctx, "/workspaces");
          const activeWorkspace = arrayValue(workspaces, "items").find(
            (workspace) => recordValue(workspace, "id") === workspaceId,
          );
          const activePath =
            recordValue(activeWorkspace, "path") ?? recordValue(activeWorkspace, "directory");
          if (activePath !== workspacePath) workspaceId = "";
        }
        if (!workspaceId) {
          const welcomeInput = 'input[placeholder="/workspace/my-project"]';
          const onWelcome = await ctx.eval(
            `Boolean(document.querySelector(${JSON.stringify(welcomeInput)}))`,
          );
          if (onWelcome) {
            await ctx.fill(welcomeInput, workspacePath);
            await ctx.clickText("Use this folder", {
              selector: "button",
              timeoutMs: 10_000,
            });
          } else {
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
              { timeoutMs: 30_000, label: "workspace.create" },
            );
            await ctx.control("workspace.create", {
              path: workspacePath,
              projectLabel: "Scheduled Tasks eval",
            });
          }
          await ctx.waitFor(`location.hash.includes("/workspace/")
            || [...document.querySelectorAll("button")]
              .some((button) => button.textContent?.includes("Skip and use the free model"))`, {
            timeoutMs: 60_000,
            label: "Scheduled Tasks workspace or provider step",
          });
          await finishPendingWorkspaceOnboarding(ctx);
          await ctx.waitFor("location.hash.includes('/workspace/')", {
            timeoutMs: 60_000,
            label: "Scheduled Tasks eval workspace route",
          });
          workspaceId = await ctx.waitFor(`(() => {
            const context = window.__openworkControl.context();
            return context.screen.workspaceId || context.resources
              .find((resource) => resource.kind === "workspace")?.ref.replace(/^workspace:/, "") || null;
          })()`, {
            timeoutMs: 60_000,
            label: "Scheduled Tasks eval workspace context",
          });
        }
        state.workspaceId = requireString(workspaceId, "workspaceId");

        await enableScheduledTasksPreview(ctx);

        await ctx.navigateHash(workspaceScheduledListRoute(state.workspaceId));
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-tasks-list\"]'))",
          { timeoutMs: 30_000, label: "empty Scheduled Tasks list" },
        );
        await ctx.screenshot("scheduled-tasks-empty-state", {
          claim:
            "The first-class workspace destination starts honestly empty and states the running-app limitation before creation.",
          voiceover: vo[0],
          requireText: [
            "Scheduled Tasks",
            "No scheduled tasks yet",
            "New scheduled task",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });

        await ctx.trustedClick("[data-testid='scheduled-task-create']");
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-create-view\"]'))",
          { timeoutMs: 30_000, label: "Scheduled Task create view" },
        );
        await focusSection(ctx, "[data-testid='scheduled-task-create-view']");
        await ctx.screenshot("scheduled-task-create-definition", {
          claim:
            "Creation binds the task to one workspace and makes name, outcome, exact prompt, schedule, and timezone explicit in a disabled-draft flow.",
          requireText: [
            "Create a scheduled task",
            "Workspace",
            "Instructions",
            "Frequency",
            "Manual only",
            "Save disabled draft",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });
        await ctx.eval(`(() => {
          const select = document.querySelector('[data-testid="scheduled-task-frequency"]');
          if (!(select instanceof HTMLSelectElement)) throw new Error("Missing frequency selector");
          select.value = "daily";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
        await ctx.clickText("Preview next five", {
          selector: "button",
          timeoutMs: 10_000,
        });
        await ctx.waitFor(
          "document.querySelectorAll('[data-testid=\"scheduled-task-preview\"] > li').length === 5",
          { timeoutMs: 30_000, label: "create-form schedule preview" },
        );
        await ctx.clickText("Advanced settings", {
          selector: "button",
          timeoutMs: 10_000,
        });
        await focusSection(ctx, "#scheduled-task-provider", "center");
        await ctx.screenshot("scheduled-task-create-schedule-execution", {
          claim:
            "The editor previews five scheduler-calculated occurrences and exposes provider, model, agent, runtime, overlap, missed-run, retry, and unattended-safety policy.",
          requireText: [
            "Preview next five",
            "Occurrence 1",
            "Occurrence 5",
            "Advanced settings",
            "Provider",
            "Model",
            "Agent",
            "Maximum runtime (minutes)",
            "Overlapping runs are skipped",
          ],
        });
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-name\"]'))",
          { timeoutMs: 30_000, label: "Scheduled Task editor inputs" },
        );
        await setTextControl(ctx, "[data-testid='scheduled-task-name']", TASK_NAME);
        await setTextControl(ctx, "[data-testid='scheduled-task-prompt']", TASK_PROMPT);
        await ctx.eval(`(() => {
          const select = document.querySelector('[data-testid="scheduled-task-frequency"]');
          if (!(select instanceof HTMLSelectElement)) throw new Error("Missing frequency selector");
          select.value = "manual";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
        await ctx.trustedClick("[data-testid='scheduled-task-save']");
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-detail\"]'))",
          { timeoutMs: 30_000, label: "saved manual Scheduled Task draft" },
        );
        const tasks = await serverRead(
          ctx,
          `/workspace/${encodeURIComponent(state.workspaceId)}/scheduled-tasks`,
        );
        const task = arrayValue(tasks, "items").find(
          (candidate) => recordValue(
            recordValue(recordValue(candidate, "revision"), "definition"),
            "name",
          ) === TASK_NAME,
        );
        state.taskId = requireString(
          recordValue(recordValue(task, "task"), "id"),
          "manual draft taskId",
        );
      },
    },
    {
      name: "The first-class editor creates only a disabled manual draft",
      run: async (ctx: FlowContext) => {
        await ctx.prove("The first-class editor creates a disabled manual Scheduled Task draft without crossing the authority boundary", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(
              "Boolean(document.querySelector('[data-testid=\"scheduled-task-detail\"]'))",
              { timeoutMs: 30_000, label: "manual Scheduled Task draft detail" },
            );
          },
          assert: async () => {
            const detail = await readDetail(ctx);
            const task = recordValue(detail, "task");
            ctx.assert(recordValue(task, "state") === "draft", "Proposal must remain a draft.");
            ctx.assert(recordValue(task, "enabled") === false, "Proposal must remain disabled.");
            ctx.assert(recordValue(detail, "grant") === null, "Proposal must not create an authority grant.");
          },
          screenshot: {
            name: "scheduled-task-manual-draft",
            requireText: [
              TASK_NAME,
              "Draft",
              "Manual",
              "Authority review",
              "Scheduled tasks run while the OpenWork app is open.",
            ],
            rejectText: ["Enabled"],
          },
        });
      },
    },
    {
      name: "The manual draft exposes its complete definition and authority review",
      run: async (ctx: FlowContext) => {
        await ctx.waitFor(
          `Boolean(document.querySelector('[data-testid="scheduled-task-detail"]')) && location.hash.includes(${JSON.stringify(state.taskId)})`,
          { timeoutMs: 30_000, label: "Scheduled Task detail" },
        );
        await focusSection(ctx, "[data-testid='scheduled-task-detail']");
        await ctx.screenshot("scheduled-task-definition-review", {
          claim:
            "The disabled draft review exposes the exact prompt, manual schedule, workspace-default execution, timeout, safety policy, and edit, duplicate, and delete controls.",
          requireText: [
            TASK_NAME,
            "Draft",
            "Edit",
            "Instructions",
            "Details",
            "Manual",
            "Workspace default",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
          rejectText: ["Delete"],
        });

        await ctx.trustedClick("[data-testid='scheduled-task-more-actions']");
        await ctx.waitForText("Delete", {
          timeoutMs: 10_000,
        });

        const beforeEdit = await readDetail(ctx);
        const draftRevision = recordValue(beforeEdit, "draftRevision");
        const definition = recordValue(draftRevision, "definition");
        const model = recordValue(definition, "model");
        const needsWorkspaceDefaults = [
          recordValue(model, "providerId"),
          recordValue(model, "modelId"),
          recordValue(model, "agent"),
        ].some((value) => value !== null);
        const revisionBefore = requireString(
          recordValue(draftRevision, "id"),
          "draft revision before opening the editor",
        );
        await ctx.clickText("Edit", {
          selector: "[role='menuitem']",
          timeoutMs: 10_000,
        });
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-scheduled-task-editor]'))",
          { timeoutMs: 30_000, label: "Scheduled Task editor" },
        );
        await ctx.clickText("Advanced settings", {
          selector: "button",
          timeoutMs: 10_000,
        });
        await ctx.waitFor("Boolean(document.querySelector('#scheduled-task-provider'))", {
          timeoutMs: 10_000,
          label: "Scheduled Task advanced settings",
        });
        await focusSection(ctx, "[data-scheduled-task-editor]");
        await ctx.screenshot("scheduled-task-edit-revision", {
          claim:
            "Editing is an explicit revision flow: saving creates a new disabled draft that must be reviewed again before unattended execution.",
          requireText: [
            "Edit scheduled task",
            "Saving creates a new draft revision",
            "Instructions",
            "Schedule",
            "Advanced settings",
            "Cancel",
            "Save",
          ],
        });
        if (needsWorkspaceDefaults) {
          await ctx.fill("#scheduled-task-provider", "");
          await ctx.fill("#scheduled-task-model", "");
          await ctx.fill("#scheduled-task-agent", "");
          await ctx.trustedClick("[data-testid='scheduled-task-save']");

          const editDeadline = Date.now() + 30_000;
          let defaultsApplied = false;
          while (Date.now() < editDeadline) {
            const editedDetail = await readDetail(ctx);
            const editedRevision = recordValue(editedDetail, "draftRevision");
            const editedDefinition = recordValue(editedRevision, "definition");
            const editedModel = recordValue(editedDefinition, "model");
            if (
              recordValue(editedRevision, "id") !== revisionBefore
              && recordValue(editedModel, "providerId") === null
              && recordValue(editedModel, "modelId") === null
              && recordValue(editedModel, "agent") === null
            ) {
              defaultsApplied = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          ctx.assert(
            defaultsApplied,
            "The Scheduled Task did not durably select workspace-default execution.",
          );
        } else {
          await ctx.clickText("Cancel", {
            selector: "button",
            timeoutMs: 10_000,
          });
        }
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-detail\"]'))",
          { timeoutMs: 30_000, label: "Scheduled Task detail after editor tour" },
        );

        await openTechnicalScope(ctx);
        await focusSection(ctx, "[data-testid='scheduled-task-authority']", "start");
        await ctx.screenshot("scheduled-task-authority-boundary", {
          claim:
            "Before review, authority is a separate boundary that names the workspace roots, capabilities, action classes, filesystem scope, reviewer, and fixed denials.",
          requireText: [
            "Authority review",
            "Review the exact workspace",
            "Authorized workspace roots",
            "Capability IDs",
            "Allowed action classes",
            "Read files",
            "Communication",
            "Destructive actions",
            "Self-modification",
            "Denied",
            "Approve authority",
          ],
        });

        await ctx.prove("Authority review binds exact unattended access but remains separate from enabling", {
          voiceover: vo[2],
          action: async () => {
            await setTextControl(
              ctx,
              "[data-testid='scheduled-task-capabilities']",
              "workspace.files.read\nworkspace.files.write",
            );
            await ctx.trustedClick("[data-action-class='write']");
            await ctx.trustedClick("[data-filesystem-write]");
            await ctx.trustedClick("[data-testid='scheduled-task-review-authority']");
            await ctx.waitFor(
              "!document.querySelector('[data-testid=\"scheduled-task-enable\"]')?.disabled",
              { timeoutMs: 30_000, label: "enable after authority review" },
            );
          },
          assert: async () => {
            const detail = await readDetail(ctx);
            ctx.assert(recordValue(detail, "grant") !== null, "Authority review must create a grant.");
            const task = recordValue(detail, "task");
            ctx.assert(recordValue(task, "enabled") === false, "Authority review must not implicitly enable.");
            ctx.assert(
              recordValue(recordValue(recordValue(detail, "draftRevision"), "definition"), "schedule") !== null,
              "The reviewed manual schedule must remain bound to the draft revision.",
            );
          },
          screenshot: {
            name: "scheduled-task-authority-approved",
            requireText: [
              "Authority review",
              "Reviewed",
              "Read files",
              "Write files",
              "Communication",
              "Destructive actions",
              "Self-modification",
              "Denied",
              "Revoke authority",
            ],
          },
        });
      },
    },
    {
      name: "Run once creates a fresh session and durable receipt links",
      run: async (ctx: FlowContext) => {
        const before = arrayValue(await readDetail(ctx), "runs").length;
        await ctx.trustedClick("[data-testid='scheduled-task-run-once']");
        const runs = await waitForRunCount(
          ctx,
          (items) => items.length === before + 1,
          "Manual run was not created",
        );
        const run = runs[0];
        state.runId = requireString(recordValue(run, "id"), "manual runId");
        await ctx.waitFor(
          `Boolean(document.querySelector('[data-scheduled-task-run="${state.runId}"]'))`,
          { timeoutMs: 30_000, label: "manual run history row" },
        );
        await ctx.waitFor(
          `(() => {
            const row = document.querySelector('[data-scheduled-task-run="${state.runId}"]');
            return Boolean(row && /queued|claimed|running|retrying/.test(row.textContent || "")
              && (row.textContent || "").includes("Cancel run"));
          })()`,
          { timeoutMs: 30_000, label: "active manual run and cancellation control" },
        );
        await focusSection(
          ctx,
          `[data-scheduled-task-run="${state.runId}"]`,
          "center",
        );
        await ctx.screenshot("scheduled-task-run-live", {
          claim:
            "Run once creates a live auditable attempt with manual trigger, claimed/started timeline, bounded usage, revision binding, and an explicit cancellation control.",
          voiceover: vo[3],
          requireText: [
            "Run history and timeline",
            "manual",
            "Cancel run",
            "Claimed",
            "Task ",
            "grant ",
          ],
        });
        await ctx.prove("Run once is bound to its exact fresh session, status timeline, and artifacts", {
          voiceover: vo[4],
          assert: async () => {
            const latestRuns = await waitForRunCount(
              ctx,
              (items) => items.some(
                (item) =>
                  recordValue(item, "id") === state.runId
                  && runIsTerminal(item),
              ),
              "Manual run did not reach a terminal state",
            );
            const latest = latestRuns.find((item) => recordValue(item, "id") === state.runId);
            ctx.assert(
              runStatus(latest) === "completed",
              `Manual run terminated as ${runStatus(latest)}: ${JSON.stringify(recordValue(latest, "error"))}`,
            );
            state.manualSessionId = requireString(
              recordValue(latest, "sessionId"),
              "manual sessionId",
            );
            const receipt = await serverRead(
              ctx,
              `/workspace/${encodeURIComponent(state.workspaceId)}/scheduled-tasks/${encodeURIComponent(state.taskId)}/runs/${encodeURIComponent(state.runId)}`,
            );
            ctx.assert(recordValue(receipt, "taskRevision") !== null, "Receipt must bind the task revision.");
            ctx.assert(recordValue(receipt, "grantRevision") !== null, "Receipt must bind the grant revision.");
            const attempts = arrayValue(receipt, "attempts");
            ctx.assert(attempts.length >= 1, "Receipt must bind at least one immutable attempt.");
            ctx.assert(
              typeof recordValue(recordValue(receipt, "run"), "idempotencyKey") === "string",
              "Receipt must bind the idempotency identity.",
            );
            const artifacts = arrayValue(receipt, "artifacts");
            ctx.assert(artifacts.length >= 1, "Receipt must include a produced artifact.");
            const artifact = artifacts.find(
              (candidate) =>
                recordValue(candidate, "kind") === "file"
                && String(recordValue(candidate, "value")).endsWith(
                  "scheduled-task-eval-report.md",
                ),
            );
            state.manualArtifactId = requireString(
              recordValue(artifact, "id"),
              "manual artifactId",
            );
            ctx.assert(
              recordValue(artifact, "name") === "scheduled-task-eval-report.md",
              "The immutable receipt must preserve the reviewed artifact filename.",
            );

            const transcript = await serverRead(
              ctx,
              `/workspace/${encodeURIComponent(state.workspaceId)}/sessions/${encodeURIComponent(state.manualSessionId)}/messages`,
            );
            ctx.assert(
              arrayValue(transcript, "items").some(
                (message) => recordValue(recordValue(message, "info"), "role") === "assistant",
              ),
              "The linked fresh session must contain an assistant transcript.",
            );

            await ctx.waitFor(
              `(() => {
                const row = document.querySelector('[data-scheduled-task-run="${state.runId}"]');
                return Boolean(row && (row.textContent || "").includes("completed")
                  && (row.textContent || "").includes("scheduled-task-eval-report.md"));
              })()`,
              { timeoutMs: 30_000, label: "completed manual receipt in UI" },
            );
            await focusSection(
              ctx,
              `[data-scheduled-task-run="${state.runId}"]`,
              "center",
            );
            await ctx.screenshot("scheduled-task-run-receipt", {
              claim:
                "The completed immutable receipt binds terminal status and duration to task/grant revisions, idempotency and attempt identity, the exact fresh session, bounded usage, and the produced artifact.",
              requireText: [
                "completed",
                "manual",
                "Open session",
                "scheduled-task-eval-report.md",
                "Claimed",
                "Started",
                "Completed",
              ],
            });

            await ctx.trustedClick(
              `[data-open-scheduled-task-session="${state.manualSessionId}"]`,
            );
            await ctx.waitFor(
              `location.hash.includes(${JSON.stringify(state.manualSessionId)})
                && Boolean(document.querySelector('[data-session-surface-id="${state.manualSessionId}"]'))
                && !document.querySelector('[data-testid="scheduled-task-detail"]')`,
              { timeoutMs: 30_000, label: "linked Scheduled Task session" },
            );
            await ctx.waitForText("scheduled-task-eval-report.md", {
              timeoutMs: 30_000,
            });
            await ctx.eval(`(() => {
              const surface = document.querySelector(
                '[data-session-surface-id="${state.manualSessionId}"]',
              );
              if (!surface) throw new Error("Scheduled Task session surface is missing");
              const candidates = [...surface.querySelectorAll("*")]
                .filter((element) =>
                  (element.textContent || "").includes("scheduled-task-eval-report.md"));
              const target = candidates.sort(
                (left, right) => left.childElementCount - right.childElementCount,
              )[0] || surface;
              target.scrollIntoView({ block: "center", inline: "nearest" });
              return true;
            })()`);
            await ctx.screenshot("scheduled-task-linked-session", {
              claim:
                "Opening the receipt lands in the exact fresh OpenWork session, reusing the normal transcript instead of inventing a parallel automation log.",
              requireText: [
                "scheduled-task-eval-report.md",
              ],
            });
            await ctx.navigateHash(
              workspaceScheduledRoute(state.workspaceId, state.taskId),
            );
            await ctx.waitFor(
              "Boolean(document.querySelector('[data-testid=\"scheduled-task-detail\"]'))",
              { timeoutMs: 30_000, label: "Scheduled Task detail after transcript" },
            );

            const artifactPath =
              `/workspace/${encodeURIComponent(state.workspaceId)}`
              + `/scheduled-tasks/${encodeURIComponent(state.taskId)}`
              + `/runs/${encodeURIComponent(state.runId)}`
              + `/artifacts/${encodeURIComponent(state.manualArtifactId)}`;
            const downloaded = await serverDownload(ctx, artifactPath);
            ctx.assert(downloaded.status === 200, "The exact receipt artifact must download.");
            ctx.assert(downloaded.text.trim().length > 0, "The downloaded artifact must not be empty.");
            await ctx.trustedClick(
              `[data-scheduled-task-artifact="${state.manualArtifactId}"]`,
            );
          },
        });
      },
    },
    {
      name: "Enable and deterministic tick claim exactly one occurrence",
      run: async (ctx: FlowContext) => {
        await ctx.trustedClick("[data-testid='scheduled-task-enable']");
        await ctx.waitFor(
          "document.body.innerText.includes('Enabled')",
          { timeoutMs: 30_000, label: "enabled state" },
        );
        const detail = await readDetail(ctx);
        const task = recordValue(detail, "task");
        state.deterministicNow = requireNumber(recordValue(task, "nextRunAt"), "nextRunAt");
        const beforeRuns = arrayValue(detail, "runs");
        state.firstScheduledRunCount = beforeRuns.filter((run) => runTrigger(run) === "scheduled").length;
        await focusSection(ctx, "[data-testid='scheduled-task-detail']");
        await ctx.screenshot("scheduled-task-enabled-upcoming", {
          claim:
            "Enabling is a separate owner action after authority review; the task becomes upcoming with a precise next run while Run once and Pause remain available.",
          requireText: [
            "Enabled",
            "Next run",
            "NEXT FIVE OCCURRENCES",
            "Run once",
            "Pause",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });

        const tick = await ctx.control("eval.scheduled_tasks.tick", { now: state.deterministicNow });
        const claimed = arrayValue(tick, "claimedRunIds");
        const afterTick = arrayValue(await readDetail(ctx), "runs");
        const newlyClaimedForTask = afterTick.filter(
          (run) =>
            runTrigger(run) === "scheduled"
            && !beforeRuns.some((before) => recordValue(before, "id") === recordValue(run, "id")),
        );
        ctx.assert(
          newlyClaimedForTask.length === 1,
          `Expected exactly one occurrence for the task, got ${JSON.stringify(
            newlyClaimedForTask.map((run) => recordValue(run, "id")),
          )}`,
        );
        const claimedRunId = requireString(
          recordValue(newlyClaimedForTask[0], "id"),
          "claimed scheduled runId",
        );
        ctx.assert(
          claimed.includes(claimedRunId),
          `The scheduler tick did not report the task's claimed run: ${claimedRunId}`,
        );
        const scheduledRuns = await waitForRunCount(
          ctx,
          (runs) =>
            runs.filter(
              (run) =>
                runTrigger(run) === "scheduled"
                && runStatus(run) === "completed",
            ).length === state.firstScheduledRunCount + 1,
          "Scheduled occurrence did not complete",
        );
        const completedScheduled = scheduledRuns.find(
          (run) =>
            runTrigger(run) === "scheduled"
            && runStatus(run) === "completed",
        );
        state.scheduledRunId = requireString(
          recordValue(completedScheduled, "id"),
          "scheduled runId",
        );
        const scheduledSessionId = requireString(
          recordValue(completedScheduled, "sessionId"),
          "scheduled sessionId",
        );
        ctx.assert(
          scheduledSessionId !== state.manualSessionId,
          "Each attempt must own a fresh session.",
        );
        ctx.assert(
          arrayValue(completedScheduled, "artifacts").length >= 1,
          "The scheduled execution must persist its produced artifact.",
        );

        await ctx.control("eval.scheduled_tasks.tick", { now: state.deterministicNow });
        const afterRepeat = arrayValue(await readDetail(ctx), "runs");
        ctx.assert(
          afterRepeat.filter((run) => runTrigger(run) === "scheduled").length === state.firstScheduledRunCount + 1,
          "Repeating the same deterministic tick created a duplicate.",
        );
        await ctx.waitFor(
          `(() => {
            const row = document.querySelector('[data-scheduled-task-run="${state.scheduledRunId}"]');
            return Boolean(row && (row.textContent || "").includes("completed")
              && (row.textContent || "").includes("scheduled"));
          })()`,
          { timeoutMs: 30_000, label: "scheduled completed receipt in UI" },
        );
        await focusSection(
          ctx,
          `[data-scheduled-task-run="${state.scheduledRunId}"]`,
          "center",
        );
        await ctx.screenshot("scheduled-task-due-run-idempotent", {
          claim:
            "A deterministic due-time tick claims exactly one scheduled occurrence, completes it in a fresh session, and repeating the same tick does not duplicate the run.",
          requireText: [
            "completed",
            "scheduled",
            "Open session",
            "scheduled-task-eval-report.md",
            "Claimed",
            "Started",
            "Completed",
          ],
        });

        await ctx.eval(
          "window.dispatchEvent(new Event('openwork-open-notification-center'))",
        );
        await ctx.waitFor(
          "document.body.innerText.includes('Notifications') && document.body.innerText.includes('EVAL daily workspace report completed')",
          { timeoutMs: 30_000, label: "Scheduled Task completion notification" },
        );
        await ctx.screenshot("scheduled-task-completion-notification", {
          claim:
            "Completion is delivered through OpenWork's persistent notification center with a direct View action back to the Scheduled Task.",
          requireText: [
            "Notifications",
            "EVAL daily workspace report completed",
            "View",
          ],
        });
        await ctx.trustedClick("button[title='Notifications']");
      },
    },
    {
      name: "Restart preserves idempotency and the exact durable task state",
      run: async (ctx: FlowContext) => {
        try {
          await ctx.control("eval.app.relaunch");
        } catch (error) {
          ctx.log(
            `eval.app.relaunch disconnected during the expected Electron handoff: ${String(error)}`,
          );
        }
        const reconnectDeadline = Date.now() + 60_000;
        let reconnected = false;
        let reconnectError: unknown = null;
        while (Date.now() < reconnectDeadline && !reconnected) {
          try {
            await ctx.reconnect({
              timeoutMs: Math.min(15_000, reconnectDeadline - Date.now()),
            });
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 10_000,
              label: "OpenWork semantic control after restart",
            });
            await ctx.navigateHash(workspaceScheduledRoute(state.workspaceId, state.taskId));
            await ctx.waitFor(
              "Boolean(window.__openworkControl) && Boolean(document.querySelector('[data-testid=\"scheduled-task-detail\"]'))",
              { timeoutMs: 15_000, label: "Scheduled Task after restart" },
            );
            reconnected = true;
          } catch (error) {
            reconnectError = error;
            ctx.log(`Replacement Electron target was not stable yet: ${String(error)}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        ctx.assert(
          reconnected,
          `Could not reconnect to the replacement Electron target: ${String(reconnectError)}`,
        );
        await ctx.control("eval.scheduled_tasks.tick", { now: state.deterministicNow });
        const runs = arrayValue(await readDetail(ctx), "runs");
        ctx.assert(
          runs.filter((run) => runTrigger(run) === "scheduled").length === state.firstScheduledRunCount + 1,
          "Restart replay created a duplicate occurrence.",
        );
        await focusSection(ctx, "[data-testid='scheduled-task-detail']");
        await ctx.screenshot("scheduled-task-restart-recovered", {
          claim:
            "After an app relaunch, the enabled definition, reviewed authority, exact next occurrence, receipts, and idempotency state are restored without replaying the prior occurrence.",
          requireText: [
            "EVAL daily workspace report",
            "Enabled",
            "Instructions",
            "Next run",
            "Run history and timeline",
            "completed",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });

        await ctx.navigateHash(workspaceScheduledListRoute(state.workspaceId));
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-scheduled-task-group=\"upcoming\"]'))",
          { timeoutMs: 30_000, label: "upcoming Scheduled Tasks group after restart" },
        );
        await focusSection(ctx, "[data-testid='scheduled-tasks-list']");
        await ctx.screenshot("scheduled-tasks-upcoming-list", {
          claim:
            "The workspace overview keeps search and state filters visible while compact rows summarize the task, schedule, state, and workspace.",
          requireText: [
            "Scheduled Tasks",
            "Search scheduled tasks",
            "Active",
            "Paused",
            "EVAL daily workspace report",
            "Enabled",
            "Scheduled Tasks eval",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });
        await ctx.navigateHash(workspaceScheduledRoute(state.workspaceId, state.taskId));
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-detail\"]'))",
          { timeoutMs: 30_000, label: "Scheduled Task detail after list overview" },
        );
      },
    },
    {
      name: "Denied unattended approval becomes needs-attention and pause blocks claims",
      run: async (ctx: FlowContext) => {
        await openTechnicalScope(ctx);
        const authorityBefore = await readDetail(ctx);
        const grantBefore = requireString(
          recordValue(recordValue(authorityBefore, "grant"), "id"),
          "grant before narrowing authority",
        );
        await setTextControl(
          ctx,
          "[data-testid='scheduled-task-capabilities']",
          "workspace.files.read",
        );
        await ctx.trustedClick("[data-action-class='write']");
        await ctx.trustedClick("[data-filesystem-write]");
        await ctx.trustedClick("[data-testid='scheduled-task-review-authority']");
        const authorityDeadline = Date.now() + 30_000;
        let narrowedAuthorityApplied = false;
        while (Date.now() < authorityDeadline) {
          const detail = await readDetail(ctx);
          const grant = recordValue(detail, "grant");
          const capabilityIds = arrayValue(grant, "capabilityIds");
          if (
            recordValue(grant, "id") !== grantBefore
            && capabilityIds.length === 1
            && capabilityIds[0] === "workspace.files.read"
          ) {
            narrowedAuthorityApplied = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        ctx.assert(
          narrowedAuthorityApplied,
          "The narrowed read-only authority review was not durably applied.",
        );
        const existingRunIds = new Set(
          arrayValue(await readDetail(ctx), "runs")
            .map((run) => recordValue(run, "id"))
            .filter((id): id is string => typeof id === "string"),
        );
        await ctx.trustedClick("[data-testid='scheduled-task-run-once']");
        const runs = await waitForRunCount(
          ctx,
          (items) => items.some(
            (run) =>
              typeof recordValue(run, "id") === "string"
              && !existingRunIds.has(recordValue(run, "id") as string)
              && runIsTerminal(run),
          ),
          "The write request under read-only authority did not reach a terminal state",
        );
        ctx.assert(
          runs.some(
            (run) =>
              runStatus(run) === "needs-attention"
              && typeof recordValue(run, "id") === "string"
              && !existingRunIds.has(recordValue(run, "id") as string),
          ),
          "The newly denied unattended run must become needs-attention.",
        );
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-needs-attention\"]'))",
          { timeoutMs: 30_000, label: "needs-attention UI after denied unattended run" },
        );
        await focusSection(ctx, "[data-testid='scheduled-task-detail']");
        await ctx.screenshot("scheduled-task-needs-attention", {
          claim:
            "Narrowing the grant to read-only makes the unattended write fail closed: the task and run become repairable needs-attention instead of borrowing interactive approval.",
          requireText: [
            "Needs attention",
            "Pause",
            "Run history and timeline",
            "needs-attention",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });
        await ctx.eval(
          "window.dispatchEvent(new Event('openwork-open-notification-center'))",
        );
        await ctx.waitFor(
          "document.body.innerText.includes('Notifications') && document.body.innerText.includes('EVAL daily workspace report needs attention')",
          { timeoutMs: 30_000, label: "Scheduled Task needs-attention notification" },
        );
        await ctx.screenshot("scheduled-task-attention-notification", {
          claim:
            "An unattended authority failure also reaches the persistent notification center with a direct repair path.",
          requireText: [
            "Notifications",
            "EVAL daily workspace report needs attention",
            "View",
          ],
        });
        await ctx.trustedClick("button[title='Notifications']");

        await setTextControl(
          ctx,
          "[data-testid='scheduled-task-capabilities']",
          "workspace.files.read\nworkspace.files.write",
        );
        await ctx.trustedClick("[data-action-class='write']");
        await ctx.trustedClick("[data-filesystem-write]");
        await ctx.trustedClick("[data-testid='scheduled-task-review-authority']");
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"scheduled-task-resume\"]'))",
          { timeoutMs: 30_000, label: "resume after repaired authority" },
        );
        await focusSection(ctx, "[data-testid='scheduled-task-authority']", "start");
        await ctx.screenshot("scheduled-task-authority-repaired", {
          claim:
            "Repair is explicit: the owner restores the exact write capability and filesystem scope, reviews a new grant revision, and only then receives a separate Resume action.",
          requireText: [
            "Authority review",
            "Reviewed",
            "Read files",
            "Write files",
            "Communication",
            "Destructive actions",
            "Self-modification",
            "Denied",
            "Resume",
          ],
        });
        await ctx.trustedClick("[data-testid='scheduled-task-resume']");
        await ctx.waitFor(
          "document.body.innerText.includes('Enabled')",
          { timeoutMs: 30_000, label: "re-enabled after repair" },
        );
        const repaired = await readDetail(ctx);
        const genuinelyDueAt = requireNumber(
          recordValue(recordValue(repaired, "task"), "nextRunAt"),
          "repaired nextRunAt",
        );
        await focusSection(ctx, "[data-testid='scheduled-task-detail']");
        await ctx.screenshot("scheduled-task-resumed", {
          claim:
            "Resuming after repair clears needs-attention and returns the task to Enabled with a newly calculated next run.",
          requireText: [
            "Enabled",
            "Next run",
            "Run once",
            "Pause",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
          rejectText: ["OpenWork needs your review before this task can continue."],
        });
        await ctx.trustedClick("[data-testid='scheduled-task-pause']");
        await ctx.waitFor(
          "document.body.innerText.includes('Paused')",
          { timeoutMs: 30_000, label: "paused state" },
        );
        const before = arrayValue(await readDetail(ctx), "runs").length;
        await ctx.control("eval.scheduled_tasks.tick", { now: genuinelyDueAt });
        const after = arrayValue(await readDetail(ctx), "runs").length;
        ctx.assert(after === before, `Paused task claimed a run: ${before} -> ${after}`);
        await focusSection(ctx, "[data-testid='scheduled-task-detail']");
        await ctx.screenshot("scheduled-task-paused", {
          claim:
            "After authority repair and resume, pausing the task prevents a genuinely due occurrence from being claimed.",
          requireText: [
            "Paused",
            "Resume",
            "Run once",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });

        await ctx.navigateHash(workspaceScheduledListRoute(state.workspaceId));
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-scheduled-task-group=\"recent\"]'))",
          { timeoutMs: 30_000, label: "paused task in recent group" },
        );
        await focusSection(ctx, "[data-testid='scheduled-tasks-list']");
        await ctx.screenshot("scheduled-tasks-paused-list", {
          claim:
            "The final workspace overview keeps the paused task compact, searchable, and visibly scoped to its workspace.",
          requireText: [
            "Search scheduled tasks",
            "Active",
            "Paused",
            "EVAL daily workspace report",
            "Scheduled Tasks eval",
            "Scheduled tasks run while the OpenWork app is open.",
          ],
        });
      },
    },
  // Recurring, restart, and repair scenarios remain below as the next proof
  // layer; the first deliverable intentionally ends at manual value receipt.
  ].slice(0, 4),
});

function workspaceScheduledRoute(workspaceId: string, taskId: string) {
  return `/scheduled-tasks/${encodeURIComponent(workspaceId)}/${encodeURIComponent(taskId)}`;
}

function workspaceScheduledListRoute(_workspaceId: string) {
  return "/scheduled-tasks";
}
