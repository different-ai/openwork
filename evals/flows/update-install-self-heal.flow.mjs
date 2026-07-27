import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "update-install-self-heal";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

async function clickExact(ctx, text, selector = "button, a") {
  await ctx.waitFor(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !entry.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 30_000, label: `click ${text}` });
}

async function setSwitch(ctx, label, checked) {
  const desired = String(checked);
  await ctx.waitFor(`Boolean(document.querySelector('[aria-label=${JSON.stringify(label)}]'))`, {
    timeoutMs: 5_000,
    label: `${label} toggle`,
  });
  await ctx.eval(`(() => {
    const toggle = document.querySelector('[aria-label=${JSON.stringify(label)}]');
    if (!toggle) return;
    toggle.scrollIntoView({ block: 'center' });
    if (toggle.getAttribute('aria-checked') !== ${JSON.stringify(desired)}) toggle.click();
  })()`);
  await ctx.waitFor(`document.querySelector('[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-checked') === ${JSON.stringify(desired)}`, {
    timeoutMs: 5_000,
    label: `${label} ${checked ? "enabled" : "disabled"}`,
  });
}

async function setAutomaticChecks(ctx, checked) {
  await setSwitch(ctx, "Check automatically", checked);
}

async function setAutomaticDownloads(ctx, checked) {
  await setSwitch(ctx, "Download automatically", checked);
}

async function configureSelfHealEval(ctx) {
  await ctx.eval(`(() => {
    const stale = window.__openworkApplyDesktopConfig;
    const fresh = window.__openworkSetDesktopConfigRefreshResult;
    if (typeof stale !== 'function' || typeof fresh !== 'function') throw new Error('Desktop policy eval bridge unavailable');
    window.__selfHealEval = { currentVersion: '0.17.0', calls: [], installAttempts: 0 };
    stale({});
    fresh({});
    window.__openworkReadDesktopVersionMetadataEval = async () => ({
      minAppVersion: '0.17.0',
      latestAppVersion: '0.17.1',
      publishedDesktopVersions: ['0.17.0', '0.17.1'],
    });
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: 'stable', feedUrl: 'eval://stable', currentVersion: window.__selfHealEval.currentVersion }),
      check: async (channel, targetVersion) => {
        window.__selfHealEval.calls.push('check:' + (targetVersion ?? 'latest'));
        const resolvedVersion = targetVersion ?? '0.17.1';
        return {
          available: resolvedVersion !== window.__selfHealEval.currentVersion,
          currentVersion: window.__selfHealEval.currentVersion,
          latestVersion: resolvedVersion,
          channel: 'stable',
          feedUrl: 'eval://stable',
          releaseDate: '2026-07-20T12:00:00.000Z',
        };
      },
      download: async () => {
        window.__selfHealEval.calls.push('download');
        return { ok: true };
      },
      installAndRestart: async () => {
        window.__selfHealEval.installAttempts += 1;
        window.__selfHealEval.calls.push('install:' + window.__selfHealEval.installAttempts);
        if (window.__selfHealEval.installAttempts === 1) return { ok: false, reason: 'update-not-downloaded' };
        return { ok: true };
      },
    };
    return true;
  })()`);
}

async function openDesktopUpdates(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl && window.__openworkApplyDesktopConfig && window.__openworkSetDesktopConfigRefreshResult)", {
    timeoutMs: 45_000,
    label: "desktop eval bridges",
  });
  await configureSelfHealEval(ctx);
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.react.settings.update-auto-check', '0');
    localStorage.setItem('openwork.react.settings.update-auto-download', '0');
  })()`);
  await ctx.navigateHash("/settings/updates");
  await ctx.waitForText("Check now", { timeoutMs: 30_000 });
  await setAutomaticChecks(ctx, false);
  await setAutomaticDownloads(ctx, false);
}

export default {
  id: FLOW_ID,
  title: "Stale desktop update installs self-heal back to a working download flow",
  kind: "user-facing",
  steps: [
    {
      name: "Frame 1 — Update downloaded and ready",
      run: async (ctx) => {
        await ctx.prove("Riley downloads the available stable update and sees it ready to install", {
          voiceover: vo[0],
          action: async () => {
            await openDesktopUpdates(ctx);
            await clickExact(ctx, "Check now", "button");
            await ctx.waitForText("Update available: v0.17.1", { timeoutMs: 15_000 });
            await clickExact(ctx, "Download", "button");
            await ctx.waitForText("Ready to install: v0.17.1", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.expectText("Install & restart");
            const calls = await ctx.eval("window.__selfHealEval.calls.slice()");
            ctx.assert(calls.some((entry) => entry.startsWith("check:")), JSON.stringify(calls));
            ctx.assert(calls.includes("download"), JSON.stringify(calls));
          },
          screenshot: { name: "update-ready", requireText: ["Ready to install: v0.17.1", "Install & restart"] },
        });
      },
    },
    {
      name: "Frame 2 — Stale install self-heals instead of dead-ending",
      run: async (ctx) => {
        await ctx.prove("A stale install attempt re-checks updates and returns to a working available state", {
          voiceover: vo[1],
          action: async () => {
            await clickExact(ctx, "Install & restart", "button");
            await ctx.waitForText("Update available: v0.17.1", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.expectNoText("Couldn't check for updates");
            await ctx.expectNoText("update-not-downloaded");
            await ctx.expectText("Download");
            const calls = await ctx.eval("window.__selfHealEval.calls.slice()");
            const installIndex = calls.indexOf("install:1");
            const checkAfterInstallIndex = calls.findIndex((entry, index) => index > installIndex && entry.startsWith("check:"));
            ctx.assert(installIndex >= 0, JSON.stringify(calls));
            ctx.assert(checkAfterInstallIndex > installIndex, JSON.stringify(calls));
          },
          screenshot: {
            name: "self-heal-available",
            requireText: ["Update available: v0.17.1", "Download"],
            rejectText: ["Couldn't check for updates", "update-not-downloaded"],
          },
        });
      },
    },
    {
      name: "Frame 3 — Second attempt installs",
      run: async (ctx) => {
        await ctx.prove("Riley downloads again and the second install request proceeds", {
          voiceover: vo[2],
          action: async () => {
            await clickExact(ctx, "Download", "button");
            await ctx.waitForText("Ready to install: v0.17.1", { timeoutMs: 15_000 });
            await clickExact(ctx, "Install & restart", "button");
            await ctx.waitFor("window.__selfHealEval.installAttempts >= 2", { timeoutMs: 15_000, label: "second install attempt" });
          },
          assert: async () => {
            const state = await ctx.eval("({ installAttempts: window.__selfHealEval.installAttempts, calls: window.__selfHealEval.calls.slice() })");
            ctx.assert(state.installAttempts === 2, JSON.stringify(state));
            ctx.assert(state.calls.includes("install:2"), JSON.stringify(state));
            await ctx.expectNoText("Couldn't check for updates");
            await ctx.expectNoText("update-not-downloaded");
          },
          screenshot: {
            name: "install-proceeds",
            requireText: ["Ready to install: v0.17.1"],
            rejectText: ["Couldn't check for updates", "update-not-downloaded"],
          },
        });
      },
    },
  ],
};
