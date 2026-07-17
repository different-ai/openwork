import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "extensions-legacy-rename";

// Narration is loaded from the approved script (evals/voiceovers/extensions-legacy-rename.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

export default {
  id: FLOW_ID,
  title: "Settings labels distinguish legacy local extensions from OpenWork Connect",
  kind: "user-facing",
  steps: [
    {
      name: "Settings sidebar shows Extensions (Legacy)",
      run: async (ctx) => {
        await ctx.prove("The Workspace settings group renames Extensions to Extensions (Legacy)", {
          voiceover: vo[0],
          claim: "Opening Settings shows the Workspace tab labeled exactly Extensions (Legacy), with no exact bare Extensions tab left in that group.",
          action: async () => {
            await enableEnglishMemoryPreview(ctx);
            await navigateToSettingsTab(ctx, "general");
          },
          assert: async () => {
            const nav = await readSettingsSidebar(ctx);
            const workspace = findGroup(nav, "Workspace");
            const labels = workspace.items.map((item) => item.label);
            ctx.assert(labels.includes("Extensions (Legacy)"), `Workspace tabs were ${JSON.stringify(labels)}.`);
            ctx.assert(!labels.includes("Extensions"), `Workspace still had an exact Extensions tab: ${JSON.stringify(labels)}.`);
          },
          screenshot: {
            name: "settings-sidebar-extensions-legacy",
            requireText: ["Workspace", "Extensions (Legacy)"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "OpenWork Connect is the final sidebar item",
      run: async (ctx) => {
        await ctx.prove("OpenWork Connect stays last in Cloud settings even when Memory is enabled", {
          voiceover: vo[1],
          claim: "The Cloud settings group shows OpenWork Connect with the alpha badge after Memory, and OpenWork Connect is the final item in the full settings sidebar.",
          action: async () => {
            await waitForSettingsShell(ctx);
            await ctx.clickText("OpenWork Connect", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitFor("location.hash.includes('/settings/connect')", { timeoutMs: 30_000, label: "connect settings route" });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/connect");
            const nav = await readSettingsSidebar(ctx);
            const cloud = findGroup(nav, "Cloud");
            const cloudLabels = cloud.items.map((item) => item.label);
            const memoryIndex = cloudLabels.indexOf("Memory");
            const connectIndex = cloudLabels.indexOf("OpenWork Connect");
            const allLabels = nav.groups.flatMap((group) => group.items.map((item) => item.label));
            const connect = cloud.items.find((item) => item.label === "OpenWork Connect");

            ctx.assert(memoryIndex !== -1, `Memory tab was not visible after enabling the feature flag: ${JSON.stringify(cloudLabels)}.`);
            ctx.assert(connectIndex !== -1, `OpenWork Connect tab was missing: ${JSON.stringify(cloudLabels)}.`);
            ctx.assert(memoryIndex < connectIndex, `Memory was not before OpenWork Connect: ${JSON.stringify(cloudLabels)}.`);
            ctx.assert(cloudLabels[cloudLabels.length - 1] === "OpenWork Connect", `OpenWork Connect was not last in Cloud: ${JSON.stringify(cloudLabels)}.`);
            ctx.assert(allLabels[allLabels.length - 1] === "OpenWork Connect", `OpenWork Connect was not last in the sidebar: ${JSON.stringify(allLabels)}.`);
            ctx.assert(
              Boolean(connect?.badges.some((badge) => badge.toLowerCase() === "alpha")),
              `OpenWork Connect was missing the alpha badge: ${JSON.stringify(connect)}.`,
            );
          },
          screenshot: {
            name: "settings-sidebar-openwork-connect-last",
            requireText: ["Cloud", "Memory", "OpenWork Connect", "ALPHA"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/connect",
          },
        });
      },
    },
    {
      name: "Extensions (Legacy) still opens the local extensions surface",
      run: async (ctx) => {
        await ctx.prove("The renamed Extensions (Legacy) tab still renders the legacy extensions panel", {
          voiceover: vo[2],
          claim: "Clicking Extensions (Legacy) opens the existing extensions route and shows the My Extensions / Marketplace pane toggle.",
          action: async () => {
            await ctx.clickText("Extensions (Legacy)", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitFor("location.hash.includes('/settings/extensions')", { timeoutMs: 30_000, label: "extensions settings route" });
            await ctx.waitForText("My Extensions", { timeoutMs: 30_000 });
            await ctx.waitForText("Marketplace", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/extensions");
            await ctx.expectText("Extensions (Legacy)");
            await ctx.expectText("My Extensions");
            await ctx.expectText("Marketplace");
          },
          screenshot: {
            name: "extensions-legacy-panel",
            requireText: ["Extensions (Legacy)", "My Extensions", "Marketplace"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions",
          },
        });
      },
    },
  ],
};

async function enableEnglishMemoryPreview(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "control API" });
  const changed = await ctx.eval(`(() => {
    const prefKey = "openwork.preferences";
    let prefs = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(prefKey) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed;
    } catch {
      prefs = {};
    }
    const featureFlags = prefs.featureFlags && typeof prefs.featureFlags === "object" && !Array.isArray(prefs.featureFlags)
      ? prefs.featureFlags
      : {};
    localStorage.setItem(prefKey, JSON.stringify({
      ...prefs,
      featureFlags: { ...featureFlags, memory: true },
    }));
    localStorage.setItem("openwork.language", "en");
    return true;
  })()`);
  ctx.assert(changed === true, "Failed to enable English locale and memory preview for the proof.");
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after reload" });
}

async function navigateToSettingsTab(ctx, tab) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, { timeoutMs: 30_000, label: `${tab} settings route` });
  await waitForSettingsShell(ctx);
}

async function waitForSettingsShell(ctx) {
  try {
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 10_000, label: "settings surface mounted" });
  } catch {
    await ctx.eval("location.reload()");
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after settings recovery reload" });
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 60_000, label: "settings surface mounted after recovery" });
  }
}

async function readSettingsSidebar(ctx) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.innerText || entry?.textContent || "").replace(/\\s+/g, " ").trim();
    const sidebars = [...document.querySelectorAll('[data-sidebar="sidebar"], aside, nav')];
    const sidebar = sidebars.find((entry) => compact(entry).includes("Back to app"))
      ?? sidebars.find((entry) => compact(entry).includes("Workspace") && compact(entry).includes("Cloud"))
      ?? sidebars[0];
    const groups = [...(sidebar?.querySelectorAll('[data-sidebar="group"]') ?? [])].map((group) => ({
      label: compact(group.querySelector('[data-sidebar="group-label"]')),
      items: [...group.querySelectorAll('[data-sidebar="menu-item"]')].map((item) => {
        const button = item.querySelector('[data-sidebar="menu-button"]');
        const spans = [...(button?.querySelectorAll('span') ?? [])].map((span) => compact(span)).filter(Boolean);
        return {
          text: compact(button),
          label: spans[0] || compact(button),
          badges: spans.slice(1),
        };
      }),
    }));
    return { text: compact(sidebar), groups };
  })()`);
}

function findGroup(nav, label) {
  const group = nav.groups.find((candidate) => candidate.label === label);
  if (!group) {
    throw new Error(`Settings group ${label} was missing: ${JSON.stringify(nav)}`);
  }
  return group;
}
