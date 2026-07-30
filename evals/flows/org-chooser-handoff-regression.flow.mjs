import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("org-chooser-handoff-regression");

const DEFAULT_ORG = {
  id: "org-acme-fixture",
  name: "Acme Robotics",
  slug: "acme-robotics",
  role: "admin",
};
const TARGET_ORG = {
  id: "org-beta-fixture",
  name: "Beta Labs",
  slug: "beta-labs",
  role: "member",
};
const ORGS = [DEFAULT_ORG, TARGET_ORG];

function installFixtureExpression() {
  return `(() => {
    const orgs = ${JSON.stringify(ORGS)};
    const defaultOrg = orgs[0];
    const targetOrg = orgs[1];
    const originalFetch = window.__openworkOrgChooserOriginalFetch ?? window.fetch.bind(window);
    window.__openworkOrgChooserOriginalFetch = originalFetch;
    window.__openworkOrgChooserFixture = {
      calls: [],
      requests: [],
      selectedOrgId: defaultOrg.id,
    };
    const fixture = window.__openworkOrgChooserFixture;
    const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
    window.fetch = async (input, init = {}) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (!url.pathname.startsWith("/api/den/")) {
        return originalFetch(input, init);
      }

      const method = String(init.method ?? "GET").toUpperCase();
      const path = url.pathname.replace("/api/den", "");
      const headers = new Headers(init.headers ?? {});
      fixture.requests.push({
        method,
        path,
        organizationId: headers.get("x-openwork-organization-id") ?? null,
      });

      if (method === "GET" && path === "/v1/me") {
        return json({ user: { id: "user-fixture", email: "alex@example.test", name: "Alex" } });
      }

      if (method === "GET" && path === "/v1/me/orgs") {
        return json({
          orgs,
          activeOrgId: defaultOrg.id,
          activeOrgSlug: defaultOrg.slug,
          defaultOrgId: defaultOrg.id,
        });
      }

      if (method === "POST" && path === "/v1/me/active-organization") {
        let organizationId = null;
        try {
          const body = JSON.parse(String(init.body ?? "{}"));
          organizationId = typeof body.organizationId === "string" ? body.organizationId : null;
        } catch {}
        fixture.calls.push({ organizationId });
        if (organizationId === targetOrg.id) fixture.selectedOrgId = targetOrg.id;
        if (organizationId === defaultOrg.id) fixture.selectedOrgId = defaultOrg.id;
        return new Response(null, { status: 204 });
      }

      if (method === "GET" && path === "/v1/me/desktop-config") {
        return json({});
      }

      if (method === "GET" && path === "/v1/llm-providers") {
        const selected = orgs.find((org) => org.id === fixture.selectedOrgId) ?? defaultOrg;
        return json({
          llmProviders: [
            {
              id: targetOrg.id + "-openai",
              source: "custom",
              providerId: "openai",
              name: selected.name + " OpenAI",
              providerConfig: {},
              hasApiKey: true,
              models: [{ id: "gpt-4.1-mini", name: "GPT-4.1 mini", config: {} }],
              createdAt: null,
              updatedAt: null,
            },
          ],
        });
      }

      if (method === "GET" && path === "/v1/marketplaces") {
        return json({
          items: [
            {
              id: "marketplace-fixture",
              name: "Team Plugins",
              description: "Shared extensions for the selected workspace",
              status: "active",
              pluginCount: 2,
              updatedAt: null,
            },
          ],
        });
      }

      return json({ error: "unhandled_fixture_route", method, path }, 404);
    };

    localStorage.setItem("openwork.den.baseUrl", window.location.origin);
    localStorage.setItem("openwork.den.authToken", "fixture-token");
    localStorage.setItem("openwork.den.activeOrgId", defaultOrg.id);
    localStorage.setItem("openwork.den.activeOrgSlug", defaultOrg.slug);
    localStorage.setItem("openwork.den.activeOrgName", defaultOrg.name);
    sessionStorage.setItem("openwork.den.handoffAutoContinueAt", String(Date.now()));
    return true;
  })()`;
}

async function prepareHandoffFixture(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "OpenWork control API",
  });
  await ctx.eval(installFixtureExpression(), { awaitPromise: true });
  const baseUrl = await ctx.eval("window.location.origin");
  await ctx.control("eval.auth.set-base-url", { baseUrl });
  await navigateAppRoute(ctx, "/welcome?orgChooserReset=" + Date.now());
  await ctx.waitFor(routeExpression("/welcome"), {
    timeoutMs: 10_000,
    label: "welcome route before onboarding fixture",
  });
  await ctx.eval(`(() => {
    localStorage.setItem("openwork.den.baseUrl", window.location.origin);
    localStorage.setItem("openwork.den.authToken", "fixture-token");
    localStorage.setItem("openwork.den.activeOrgId", ${JSON.stringify(DEFAULT_ORG.id)});
    localStorage.setItem("openwork.den.activeOrgSlug", ${JSON.stringify(DEFAULT_ORG.slug)});
    localStorage.setItem("openwork.den.activeOrgName", ${JSON.stringify(DEFAULT_ORG.name)});
    sessionStorage.setItem("openwork.den.handoffAutoContinueAt", String(Date.now()));
    return true;
  })()`);
  await navigateAppRoute(ctx, "/onboarding?orgChooserHandoffRegression=" + Date.now());
}

function routeExpression(path) {
  return `(() => window.__OPENWORK_ELECTRON__
    ? location.hash.includes(${JSON.stringify(path)})
    : location.pathname === ${JSON.stringify(path)})()`;
}

async function navigateAppRoute(ctx, route) {
  await ctx.eval(`(() => {
    const route = ${JSON.stringify(route)};
    if (window.__OPENWORK_ELECTRON__) {
      window.location.hash = route;
    } else {
      window.history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    return true;
  })()`);
}

function fixtureSnapshotExpression() {
  return `(() => ({
    calls: window.__openworkOrgChooserFixture?.calls ?? [],
    requests: window.__openworkOrgChooserFixture?.requests ?? [],
    selectedOrgId: window.__openworkOrgChooserFixture?.selectedOrgId ?? null,
    activeOrgId: localStorage.getItem("openwork.den.activeOrgId"),
    activeOrgName: localStorage.getItem("openwork.den.activeOrgName"),
    handoffAutoContinueAt: sessionStorage.getItem("openwork.den.handoffAutoContinueAt"),
    text: document.body.innerText,
  }))()`;
}

async function waitForChooser(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    const onOnboarding = window.__OPENWORK_ELECTRON__
      ? location.hash.includes("/onboarding")
      : location.pathname === "/onboarding";
    return onOnboarding
      && text.includes("Choose your organization")
      && text.includes(${JSON.stringify(DEFAULT_ORG.name)})
      && text.includes(${JSON.stringify(TARGET_ORG.name)});
  })()`, { timeoutMs: 45_000, label: "multi-org chooser after handoff" });
}

async function chooseTargetOrg(ctx) {
  const clicked = await ctx.eval(`(() => {
    const label = [...document.querySelectorAll("label")]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(TARGET_ORG.name)}));
    label?.scrollIntoView({ block: "center" });
    label?.click();
    return Boolean(label);
  })()`);
  ctx.assert(clicked, `Could not click ${TARGET_ORG.name}.`);
  await ctx.clickText("Continue with organization", { selector: "button", timeoutMs: 10_000 });
}

export default {
  id: "org-chooser-handoff-regression",
  title: "Desktop handoff keeps multi-organization choice explicit",
  kind: "user-facing",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A desktop handoff with two organizations still shows the chooser", {
          voiceover: vo[0],
          action: async () => {
            await prepareHandoffFixture(ctx);
            await waitForChooser(ctx);
          },
          assert: async () => {
            const snapshot = await ctx.eval(fixtureSnapshotExpression());
            ctx.assert(snapshot.handoffAutoContinueAt, "The handoff auto-continue flag was not present.");
            ctx.assert(snapshot.calls.length === 0, `Expected no automatic active-org POST before user choice: ${JSON.stringify(snapshot.calls)}`);
            ctx.assert(snapshot.activeOrgId === DEFAULT_ORG.id, `Default org should remain active before choice: ${JSON.stringify(snapshot)}`);
            ctx.assert(snapshot.text.includes(DEFAULT_ORG.name) && snapshot.text.includes(TARGET_ORG.name), `Chooser did not show both orgs: ${snapshot.text}`);
          },
          screenshot: {
            name: "handoff-multi-org-chooser",
            claim: "After a recent handoff, accounts with two organizations still see both organization choices.",
            requireText: ["Choose your organization", DEFAULT_ORG.name, TARGET_ORG.name, "Continue with organization"],
            rejectText: ["Loading organizations", "Loading available resources", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Choosing the non-default organization activates it before resources load", {
          voiceover: vo[1],
          action: async () => {
            await waitForChooser(ctx);
            await chooseTargetOrg(ctx);
          },
          assert: async () => {
            await ctx.waitFor(`(() => {
              const text = document.body.innerText;
              return text.includes(${JSON.stringify(TARGET_ORG.name)})
                && text.includes("You have access to the following resources.")
                && text.includes("AI Providers");
            })()`, { timeoutMs: 45_000, label: "target org resources" });
            const snapshot = await ctx.eval(fixtureSnapshotExpression());
            ctx.assert(snapshot.activeOrgId === TARGET_ORG.id, `Active org id did not update: ${JSON.stringify(snapshot)}`);
            ctx.assert(snapshot.activeOrgName === TARGET_ORG.name, `Active org name did not update: ${JSON.stringify(snapshot)}`);
            ctx.assert(snapshot.calls.length === 1, `Expected exactly one active-org POST after clicking Continue: ${JSON.stringify(snapshot.calls)}`);
            ctx.assert(snapshot.calls[0]?.organizationId === TARGET_ORG.id, `The POST selected the wrong organization: ${JSON.stringify(snapshot.calls)}`);
          },
          screenshot: {
            name: "handoff-selected-org-resources",
            claim: "After selecting Beta Labs, the resources screen is scoped to Beta Labs.",
            requireText: [TARGET_ORG.name, "You have access to the following resources.", "AI Providers", "Marketplaces"],
            rejectText: ["Choose your organization", "Something went wrong"],
          },
        });
      },
    },
  ],
};
