import {
  denWebUrl,
  signInViaBrowser,
} from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-skill-crud-complete-body";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_EMAIL =
  process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD =
  process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const unique = Date.now().toString(36);
const state = {
  pluginId: "",
  pluginName: `skill-proof-plugin-${unique}`,
  skillId: "",
  originalName: `skill-proof-${unique}`,
  editedName: `skill-proof-${unique}-edited`,
  originalDescription: "Use this skill to prepare a careful incident handoff.",
  editedDescription:
    "Use this updated skill to prepare and verify an incident handoff.",
  originalBody: [
    "# Incident handoff",
    "",
    "Keep the complete context visible:",
    "",
    "- Summarize impact",
    "- List owners and next steps",
    "",
    "```sh",
    "openwork verify-handoff",
    "```",
  ].join("\n"),
  editedBody: [
    "# Verified incident handoff",
    "",
    "Preserve the complete updated context:",
    "",
    "1. Confirm current impact",
    "2. Record owners and next steps",
    "3. Link the verification receipt",
    "",
    "```sh",
    "openwork verify-handoff --strict",
    "```",
  ].join("\n"),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual:
      actual === undefined
        ? undefined
        : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(
    condition,
    `${assertion}${
      actual === undefined
        ? ""
        : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`
    }`,
  );
}

async function navigateTo(ctx, path) {
  const url = new URL(path, denWebUrl()).toString();
  await ctx.eval(
    `(() => { location.assign(${JSON.stringify(url)}); return true; })()`,
  );
  await ctx.waitFor("document.readyState === 'complete'", {
    timeoutMs: 30_000,
    label: `load ${path}`,
  });
}

async function setEditorValues(ctx, { name, description, body }) {
  const filled = await ctx.eval(`(() => {
    const setNative = (element, value) => {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      descriptor.set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const name = document.querySelector('input[placeholder="e.g. customer-research"]');
    const description = document.querySelector('input[placeholder="When should an agent use this skill?"]');
    const body = document.querySelector('textarea[placeholder^="# Instructions"]');
    if (!name || !description || !body) return false;
    setNative(name, ${JSON.stringify(name)});
    setNative(description, ${JSON.stringify(description)});
    setNative(body, ${JSON.stringify(body)});
    return true;
  })()`);
  witness(ctx, filled, "The complete skill editor can be filled");
}

async function clickButton(ctx, label) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) =>
        (entry.textContent ?? "").replace(/\\s+/g, " ").trim() ===
          ${JSON.stringify(label)} && !entry.disabled
      );
    button?.click();
    return Boolean(button);
  })()`);
  witness(ctx, clicked, `The ${label} button is available`);
}

async function createOwningPlugin(ctx) {
  const created = await ctx.eval(`(async () => {
    const response = await fetch("/api/den/v1/plugins", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: ${JSON.stringify(state.pluginName)},
        description: "Temporary plugin for the Skill CRUD proof."
      }),
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      id: body?.item?.id ?? "",
      error: body?.error ?? null,
    };
  })()`, { awaitPromise: true });
  witness(
    ctx,
    created.ok && typeof created.id === "string" && created.id.length > 0,
    "The proof creates an owning plugin through the real Den API",
    created,
  );
  state.pluginId = created.id;
}

function screenshot(name, claim, requireText, rejectText = []) {
  return {
    name,
    claim,
    requireText,
    rejectText: [
      "Failed to load",
      "Failed to save",
      "Something went wrong",
      ...rejectText,
    ],
  };
}

export default {
  id: FLOW_ID,
  title: "Den manages a complete skill inside its owning plugin",
  kind: "user-facing",
  preserveTheme: true,
  spec: `evals/voiceovers/${FLOW_ID}.md`,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Create a complete skill",
      run: async (ctx) => {
        await ctx.prove(
          "An administrator can fill a new skill with complete Markdown instructions",
          {
            voiceover: vo[0],
            action: async () => {
              if (ctx.client?.send) {
                await ctx.client.send("Emulation.setDeviceMetricsOverride", {
                  width: 1440,
                  height: 1000,
                  deviceScaleFactor: 1,
                  mobile: false,
                });
              }
              await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
              await navigateTo(ctx, "/dashboard/plugins");
              await ctx.waitForText("Plugins", { timeoutMs: 30_000 });
              await createOwningPlugin(ctx);
              await navigateTo(
                ctx,
                `/dashboard/plugins/${encodeURIComponent(state.pluginId)}/skills/new`,
              );
              await ctx.waitForText("Create a skill", { timeoutMs: 30_000 });
              await setEditorValues(ctx, {
                name: state.originalName,
                description: state.originalDescription,
                body: state.originalBody,
              });
            },
            assert: async () => {
              const values = await ctx.eval(`(() => ({
                name: document.querySelector('input[placeholder="e.g. customer-research"]')?.value ?? "",
                description: document.querySelector('input[placeholder="When should an agent use this skill?"]')?.value ?? "",
                body: document.querySelector('textarea[placeholder^="# Instructions"]')?.value ?? "",
              }))()`);
              witness(
                ctx,
                values.name === state.originalName &&
                  values.description === state.originalDescription &&
                  values.body === state.originalBody,
                "The editor retains the complete name, description, and body",
                values,
              );
            },
            screenshot: screenshot(
              "skill-create-complete-body",
              "The Den skill editor contains complete multi-line Markdown instructions.",
              ["Create a skill", "Name", "Description", "Skill body"],
            ),
          },
        );
      },
    },
    {
      name: "Read the complete body",
      run: async (ctx) => {
        await ctx.prove(
          "Saving opens a detail page that displays the complete skill body",
          {
            voiceover: vo[1],
            action: async () => {
              await clickButton(ctx, "Create skill");
              await ctx.waitFor(
                `location.pathname.startsWith(${JSON.stringify(
                  `/dashboard/plugins/${state.pluginId}/skills/`,
                )}) && !location.pathname.endsWith('/new')`,
                {
                  timeoutMs: 45_000,
                  label: "created skill detail route",
                },
              );
              state.skillId = await ctx.eval(
                "location.pathname.split('/').filter(Boolean).at(-1)",
              );
              witness(
                ctx,
                typeof state.skillId === "string" && state.skillId.length > 0,
                "The saved skill has a stable detail route",
                { skillId: state.skillId },
              );
              await ctx.waitForText("Complete skill body", {
                timeoutMs: 30_000,
              });
            },
            assert: async () => {
              const detail = await ctx.eval(`(() => ({
                title: document.querySelector("h1")?.textContent?.trim() ?? "",
                description: document.querySelector("header p")?.textContent?.trim() ?? "",
                body: document.querySelector("article pre")?.textContent ?? "",
                bodyBackgroundColor: document.querySelector("article pre")
                  ? getComputedStyle(document.querySelector("article pre")).backgroundColor
                  : "",
              }))()`);
              witness(
                ctx,
                detail.title === state.originalName &&
                  detail.description === state.originalDescription &&
                  detail.body === state.originalBody &&
                  detail.bodyBackgroundColor === "rgb(249, 250, 251)",
                "The detail page shows the exact complete stored skill on a light surface",
                detail,
              );
            },
            screenshot: screenshot(
              "skill-detail-complete-body",
              "The detail page visibly shows the entire skill body without truncation.",
              [
                state.originalName,
                "Complete skill body",
                "Incident handoff",
                "openwork verify-handoff",
              ],
            ),
          },
        );
      },
    },
    {
      name: "Edit and reload",
      run: async (ctx) => {
        await ctx.prove(
          "Skill edits persist exactly after a full page reload",
          {
            voiceover: vo[2],
            action: async () => {
              await navigateTo(
                ctx,
                `/dashboard/plugins/${encodeURIComponent(state.pluginId)}/skills/${encodeURIComponent(state.skillId)}/edit`,
              );
              await ctx.waitForText(`Edit ${state.originalName}`, {
                timeoutMs: 30_000,
              });
              await setEditorValues(ctx, {
                name: state.editedName,
                description: state.editedDescription,
                body: state.editedBody,
              });
              await clickButton(ctx, "Save changes");
              await ctx.waitFor(
                `location.pathname === ${JSON.stringify(
                  `/dashboard/plugins/${state.pluginId}/skills/${state.skillId}`,
                )}`,
                { timeoutMs: 45_000, label: "updated skill detail route" },
              );
              await ctx.eval("location.reload(); true");
              await ctx.waitFor("document.readyState === 'complete'", {
                timeoutMs: 30_000,
                label: "reloaded updated skill",
              });
              await ctx.waitForText(state.editedName, { timeoutMs: 30_000 });
            },
            assert: async () => {
              const detail = await ctx.eval(`(() => ({
                title: document.querySelector("h1")?.textContent?.trim() ?? "",
                description: document.querySelector("header p")?.textContent?.trim() ?? "",
                body: document.querySelector("article pre")?.textContent ?? "",
              }))()`);
              witness(
                ctx,
                detail.title === state.editedName &&
                  detail.description === state.editedDescription &&
                  detail.body === state.editedBody,
                "The reloaded detail page shows every saved edit exactly",
                detail,
              );
            },
            screenshot: screenshot(
              "skill-edits-persist-after-reload",
              "The reloaded detail page visibly retains the edited complete body.",
              [
                state.editedName,
                state.editedDescription,
                "Verified incident handoff",
                "openwork verify-handoff --strict",
              ],
            ),
          },
        );
      },
    },
    {
      name: "Delete the exact skill",
      run: async (ctx) => {
        await ctx.prove(
          "The named confirmation deletes only the selected skill",
          {
            voiceover: vo[3],
            action: async () => {
              await clickButton(ctx, "Delete");
              await ctx.waitForText(`Delete “${state.editedName}”?`, {
                timeoutMs: 15_000,
              });
              await clickButton(ctx, `Delete “${state.editedName}”`);
              await ctx.waitFor(`location.pathname === ${JSON.stringify(
                `/dashboard/plugins/${state.pluginId}`,
              )}`, {
                timeoutMs: 45_000,
                label: "owning plugin after deletion",
              });
              await sleep(1_000);
            },
            assert: async () => {
              const catalog = await ctx.eval(`(() => ({
                text: document.body.innerText,
                hrefs: [...document.querySelectorAll('a')].map((entry) => entry.getAttribute('href')),
              }))()`);
              witness(
                ctx,
                !catalog.text.includes(state.editedName) &&
                  !catalog.hrefs.some(
                    (href) =>
                      typeof href === "string" &&
                      href.includes(encodeURIComponent(state.skillId)),
                  ),
                "The deleted skill is absent from the catalog",
                {
                  nameVisible: catalog.text.includes(state.editedName),
                  detailLinkVisible: catalog.hrefs.some(
                    (href) =>
                      typeof href === "string" &&
                      href.includes(encodeURIComponent(state.skillId)),
                  ),
                },
              );
            },
            screenshot: screenshot(
              "skill-deleted-from-catalog",
              "The owning plugin no longer contains the deleted skill.",
              [state.pluginName, "No skills in this plugin yet.", "Add skill"],
              [state.editedName],
            ),
          },
        );
      },
    },
  ],
};
