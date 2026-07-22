import http from "node:http";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("app-icon-auto-reload");
const ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsDeGA9wiEGRkoEP2Xmevc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B99yyDomP74MAAAAASUVORK5CYII=";
const ORG = { id: "org_eval_branding", name: "Acme Robotics", slug: "acme-robotics", role: "owner" };

function json(response, body) {
  response.writeHead(200, {
    "access-control-allow-headers": "authorization,content-type,x-openwork-legacy-org-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function startBrandingServer(ctx) {
  const icon = Buffer.from(ICON_BASE64, "base64");
  const server = http.createServer((request, response) => {
    const requestPath = request.url?.replace(/^\/api\/den/, "") ?? "";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "authorization,content-type,x-openwork-legacy-org-id",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-origin": "*",
      });
      response.end();
      return;
    }
    if (requestPath === "/icon.png") {
      response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "image/png" });
      response.end(icon);
      return;
    }
    if (requestPath === "/v1/me") {
      json(response, { user: { id: "usr_eval", email: "alex@acme.test", name: "Alex Chen" } });
      return;
    }
    if (requestPath === "/v1/me/orgs") {
      json(response, { orgs: [ORG], activeOrgId: ORG.id, activeOrgSlug: ORG.slug });
      return;
    }
    if (requestPath === "/v1/me/desktop-config") {
      const iconUrl = `http://127.0.0.1:${server.address().port}/icon.png`;
      json(response, {
        brandAppName: "Acme Work",
        brandLogoUrl: iconUrl,
        brandIconUrl: iconUrl,
        brandAccentColor: "violet",
      });
      return;
    }
    if (requestPath === "/v1/llm-providers") {
      json(response, { llmProviders: [] });
      return;
    }
    if (requestPath.startsWith("/v1/marketplaces")) {
      json(response, {
        items: [{
          id: "marketplace_eval",
          name: "Acme Extensions",
          description: "Organization-provided tools",
          status: "active",
          pluginCount: 3,
        }],
      });
      return;
    }
    if (requestPath === "/v1/app-version") {
      json(response, { minAppVersion: "0.17.1", latestAppVersion: "0.17.30", publishedDesktopVersions: ["0.17.30"] });
      return;
    }
    if (requestPath === "/v1/me/active-organization" && request.method === "POST") {
      json(response, { ok: true });
      return;
    }
    json(response, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  ctx.brandingServer = server;
  ctx.denBaseUrl = `http://127.0.0.1:${server.address().port}`;
  ctx.org = ORG;
}

async function seedDesktopSession(ctx) {
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.den.authToken', 'eval-token');
    localStorage.setItem('openwork.den.activeOrgId', ${JSON.stringify(ctx.org.id)});
    localStorage.setItem('openwork.den.activeOrgSlug', ${JSON.stringify(ctx.org.slug)});
    localStorage.setItem('openwork.den.activeOrgName', ${JSON.stringify(ctx.org.name)});
    localStorage.removeItem('openwork.den.appliedBrandingFingerprint');
    localStorage.removeItem('openwork.den.brandingRestartResume');
    return true;
  })()`);
  await ctx.control("eval.auth.set-base-url", { baseUrl: ctx.denBaseUrl });
  await ctx.eval("location.hash = '/onboarding'; location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 45_000, label: "control API after onboarding reload" });
  await ctx.eval(`(() => {
    window.__openworkUpdateDownloadedForOnboarding = false;
    window.__openworkOnboardingInstallCalled = false;
    window.__openworkReadDesktopVersionMetadataEval = async () => ({
      minAppVersion: '0.17.1',
      latestAppVersion: '0.17.30',
      publishedDesktopVersions: ['0.17.30'],
    });
    window.__openworkOnboardingUpdaterEvalBridge = {
      getChannel: async () => ({ channel: 'stable', feedUrl: 'eval', currentVersion: '0.17.29' }),
      check: async () => ({
        available: true,
        currentVersion: '0.17.29',
        latestVersion: '0.17.30',
        channel: 'stable',
        feedUrl: 'eval',
      }),
      download: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        window.__openworkUpdateDownloadedForOnboarding = true;
        return { ok: true };
      },
      installAndRestart: async () => {
        window.__openworkOnboardingInstallCalled = true;
        return { ok: true };
      },
    };
    window.dispatchEvent(new CustomEvent('openwork-den-settings-changed', { detail: {} }));
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { token: 'eval-token' } }));
    return true;
  })()`);
}

export default {
  id: "app-icon-auto-reload",
  title: "Branded cloud onboarding prepares one restart before entering the workspace",
  kind: "user-facing",
  steps: [
    {
      name: "Organization resources",
      run: async (ctx) => {
        await ctx.prove("A signed-in member chooses the branded organization and reviews its resources", {
          voiceover: vo[0],
          action: async () => {
            await startBrandingServer(ctx);
            await seedDesktopSession(ctx);
            await ctx.waitForText("Choose your organization", { timeoutMs: 45_000 });
            await ctx.clickText(ctx.org.name, { selector: "label, [role=radio]", timeoutMs: 10_000 });
            await ctx.clickText("Continue with organization", { timeoutMs: 10_000 });
            await ctx.waitForText("Continue to workspace", { timeoutMs: 45_000 });
            await ctx.waitFor("document.body.innerText.trim() !== 'Preparing workspace'", {
              timeoutMs: 45_000,
              label: "resource page visible after workspace preparation",
            });
            await ctx.waitFor(`(() => {
              const overlay = document.querySelector('[role="status"][aria-live="polite"]');
              return !overlay || getComputedStyle(overlay).opacity === '0';
            })()`, { timeoutMs: 45_000, label: "boot overlay hidden" });
          },
          assert: async () => {
            await ctx.expectText("You have access to the following resources");
            await ctx.expectText("Continue to workspace");
          },
          screenshot: {
            name: "organization-resources",
            requireText: ["Acme Robotics", "You have access to the following resources", "Continue to workspace"],
            hashIncludes: "/onboarding",
          },
        });
      },
    },
    {
      name: "Brand identity prepared",
      run: async (ctx) => {
        await ctx.prove("OpenWork fetches and prepares the selected organization's desktop identity", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("Continue to workspace", { timeoutMs: 10_000 });
            await ctx.waitForText("Preparing workspace identity", { timeoutMs: 10_000 });
            await ctx.waitFor("document.body.innerText.trim() !== 'Preparing workspace'", {
              timeoutMs: 45_000,
              label: "branding preparation page visible",
            });
            await ctx.waitFor(`(() => {
              const overlay = document.querySelector('[role="status"][aria-live="polite"]');
              return !overlay || getComputedStyle(overlay).opacity === '0';
            })()`, { timeoutMs: 45_000, label: "boot overlay hidden during branding preparation" });
          },
          assert: async () => {
            await ctx.expectText("Preparing workspace identity");
            const config = await ctx.eval(`(() => {
              const suffix = '::' + ${JSON.stringify(ctx.org.id)};
              const key = Object.keys(localStorage).find((candidate) => candidate.startsWith('openwork.den.desktopConfig:') && candidate.endsWith(suffix));
              return JSON.parse(key ? localStorage.getItem(key) ?? '{}' : '{}');
            })()`);
            ctx.assert(config.brandAppName === "Acme Work", "Fresh desktop config did not cache the branded app name.");
            ctx.assert(typeof config.brandIconUrl === "string", "Fresh desktop config did not cache the app icon.");
          },
          screenshot: {
            name: "brand-identity-ready",
            requireText: ["Preparing workspace identity", "checking for an application update"],
          },
        });
      },
    },
    {
      name: "Update staged",
      run: async (ctx) => {
        await ctx.prove("An eligible application update is downloaded before restart is offered", {
          voiceover: vo[2],
          action: async () => {
            await ctx.waitForText("Workspace identity is ready", { timeoutMs: 60_000 });
          },
          assert: async () => {
            ctx.assert(await ctx.eval("window.__openworkUpdateDownloadedForOnboarding === true"), "The update was not downloaded.");
            await ctx.expectText("Application update downloaded");
          },
          screenshot: {
            name: "application-update-downloaded",
            requireText: ["Application update downloaded", "Restart OpenWork"],
          },
        });
      },
    },
    {
      name: "One restart choice",
      run: async (ctx) => {
        await ctx.prove("The member gets one clear restart choice without being trapped", {
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Why restart?", { selector: "summary", timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("Restart OpenWork");
            await ctx.expectText("Continue without restarting");
            await ctx.expectText("refreshes the workspace name and icon");
          },
          screenshot: {
            name: "one-restart-choice",
            requireText: ["Restart OpenWork", "Continue without restarting", "refreshes the workspace name and icon"],
          },
        });
      },
    },
    {
      name: "Direct workspace resume",
      run: async (ctx) => {
        await ctx.prove("The coordinated restart resumes directly into the selected branded workspace", {
          voiceover: vo[4],
          action: async () => {
            await ctx.clickText("Restart OpenWork", { timeoutMs: 10_000 });
            await ctx.waitFor("window.__openworkOnboardingInstallCalled === true", {
              timeoutMs: 10_000,
              label: "coordinated updater install",
            });
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 45_000, label: "app after restart" });
            await ctx.waitFor("location.hash.includes('/session')", { timeoutMs: 45_000, label: "workspace session route" });
          },
          assert: async () => {
            await ctx.expectNoText("Choose your organization");
            await ctx.expectNoText("Workspace identity is ready");
            ctx.assert(
              await ctx.eval("localStorage.getItem('openwork.den.brandingRestartResume') === null"),
              "The one-shot restart resume marker was not consumed.",
            );
            await new Promise((resolve) => ctx.brandingServer.close(resolve));
          },
          screenshot: {
            name: "workspace-after-one-restart",
            rejectText: ["Choose your organization", "Workspace identity is ready"],
            hashIncludes: "/session",
          },
        });
      },
    },
  ],
};
