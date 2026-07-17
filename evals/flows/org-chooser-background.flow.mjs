import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denWebUrl, signInApi as signIn } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("org-chooser-background");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const EVAL_ORG_NAME = "Chooser Background Eval Org";
const PENDING_ORG_SELECTION_KEY = "openwork:web:pending-org-selection";
const AUTH_TOKEN_KEY = "openwork:web:auth-token";

const state = {
  token: null,
  orgs: [],
  targetOrg: null,
};

function authHeaders() {
  return { authorization: `Bearer ${state.token}` };
}

function denWebRoute(path) {
  return new URL(path, `${denWebUrl()}/`).toString();
}

function cacheBustedUrl(path, label) {
  const url = new URL(denWebRoute(path));
  url.searchParams.set("orgChooserBackground", `${label}-${Date.now()}`);
  return url.toString();
}

async function applyViewport(ctx, width, height, mobile) {
  if (!ctx.client?.send) {
    ctx.log("Viewport emulation skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  }).catch((error) => {
    ctx.log(`Viewport emulation skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function listOrgs(ctx) {
  const { response, body } = await denApiFetch("/v1/me/orgs", {
    headers: authHeaders(),
  });
  ctx.assert(response.ok, `Listing organizations failed (${response.status}): ${JSON.stringify(body)}`);
  const orgs = body.orgs ?? [];
  ctx.assert(Array.isArray(orgs), `Organization list response was not an array: ${JSON.stringify(body)}`);
  return orgs;
}

async function ensureMultiOrgAccount(ctx) {
  state.token = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(Boolean(state.token), `API sign-in failed for ${ADMIN_EMAIL}.`);

  let orgs = await listOrgs(ctx);
  if (orgs.length < 2) {
    const existingEvalOrg = orgs.find((org) => org.name === EVAL_ORG_NAME) ?? null;
    if (!existingEvalOrg) {
      const created = await denApiFetch("/v1/org", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: EVAL_ORG_NAME }),
      });
      ctx.assert(
        created.response.ok,
        `Creating the chooser eval org failed (${created.response.status}): ${JSON.stringify(created.body)} — this flow needs DEN_ORG_MODE=multi_org.`,
      );
    }
    orgs = await listOrgs(ctx);
  }

  ctx.assert(orgs.length >= 2, `Expected a multi-org account, found ${orgs.length} organization(s).`);
  state.orgs = orgs;
  state.targetOrg = orgs.find((org) => org.name === "Acme Robotics" || org.slug?.startsWith("acme"))
    ?? orgs.find((org) => org.slug === "default")
    ?? orgs[0];
  ctx.assert(Boolean(state.targetOrg), "No organization was available to select.");
}

async function hardNavigateToDen(ctx, path, label) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(cacheBustedUrl(path, label))}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `Den web loaded ${path}` });
}

async function waitForEmailFirstRoot(ctx) {
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      return location.pathname === '/'
        && !document.querySelector('[data-testid="org-chooser-root"]')
        && !text.includes('Dashboard')
        && text.includes('Start using OpenWork')
        && Boolean(document.querySelector('input[type="email"]'))
        && localStorage.getItem(${JSON.stringify(AUTH_TOKEN_KEY)}) === null;
    })()`,
    { timeoutMs: 45_000, label: "email-first signed-out root" },
  );
}

async function clearDenWebSession(ctx) {
  await hardNavigateToDen(ctx, "/", "pre-signout");
  await ctx.eval(
    `(() => {
      localStorage.removeItem(${JSON.stringify(AUTH_TOKEN_KEY)});
      sessionStorage.clear();
      return fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'include',
      }).catch(() => null).then(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
    })()`,
    { awaitPromise: true },
  );
  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch((error) => {
      ctx.log(`Cookie clear skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
    await ctx.client.send("Network.clearBrowserCache", {}).catch((error) => {
      ctx.log(`Cache clear skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await hardNavigateToDen(ctx, "/", "signed-out-root");
  await waitForEmailFirstRoot(ctx);
}

function chooserOrLoadedDashboardExpression() {
  return `(() => {
    const text = document.body?.innerText ?? '';
    if (document.querySelector('[data-testid="org-chooser-root"]')) return true;
    return location.pathname.startsWith('/dashboard')
      && Boolean(document.querySelector('aside nav'))
      && Boolean(document.querySelector('main.overflow-y-auto'))
      && (text.includes('Feedback') || text.includes('Docs'))
      && !text.includes('Refreshing workspace')
      && !text.includes('No active session found')
      && !text.includes('Failed to load')
      && !text.includes('Start using OpenWork');
  })()`;
}

async function submitSignIn(ctx) {
  await ctx.waitFor(
    "Boolean(document.querySelector('input[type=\"email\"]'))",
    { timeoutMs: 30_000, label: "email field" },
  );

  const passwordAlreadyVisible = await ctx.eval("Boolean(document.querySelector('input[type=\"password\"]'))");
  if (!passwordAlreadyVisible) {
    await ctx.fill('input[type="email"]', ADMIN_EMAIL);
    const advanced = await ctx.eval(`(() => {
      const form = document.querySelector('input[type="email"]')?.closest('form');
      const button = form?.querySelector('button[type="submit"]');
      button?.click();
      return Boolean(button);
    })()`);
    ctx.assert(advanced, "No Next button found on the email-first sign-in card.");
    await ctx.waitFor(
      "Boolean(document.querySelector('input[type=\"password\"]'))",
      { timeoutMs: 20_000, label: "password step" },
    );
  } else {
    const switchedToSignIn = await ctx.eval(`(() => {
      const button = [...document.querySelectorAll('button[type="button"]')]
        .find((entry) => (entry.textContent ?? '').trim() === 'Sign in');
      button?.click();
      return Boolean(button);
    })()`);
    if (switchedToSignIn) {
      await ctx.waitFor(
        `(() => {
          const submit = document.querySelector('button[type="submit"]');
          return (submit?.textContent ?? '').includes('Sign in');
        })()`,
        { timeoutMs: 10_000, label: "sign-in form selected" },
      );
    }
    await ctx.fill('input[type="email"]', ADMIN_EMAIL);
  }

  await ctx.fill('input[type="password"]', ADMIN_PASSWORD);
  const submitted = await ctx.eval(`(() => {
    const button = document.querySelector('button[type="submit"]');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(submitted, "No submit button found on the sign-in card.");
}

async function waitForChooser(ctx) {
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-testid="org-chooser-root"]')) && document.body.innerText.includes('Choose an organization')`,
    { timeoutMs: 60_000, label: "organization chooser" },
  );
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-testid="org-chooser-background"] canvas'))`,
    { timeoutMs: 30_000, label: "Dithering shader canvas" },
  );
}

async function forceChooser(ctx) {
  const chooserUrl = cacheBustedUrl("/dashboard", "force-chooser");
  await ctx.eval(`(() => {
    window.sessionStorage.setItem(${JSON.stringify(PENDING_ORG_SELECTION_KEY)}, '1');
    window.location.href = ${JSON.stringify(chooserUrl)};
    return true;
  })()`);
  await waitForChooser(ctx);
}

async function openFreshChooser(ctx) {
  await applyViewport(ctx, 1280, 900, false);
  await clearDenWebSession(ctx);
  await submitSignIn(ctx);
  await ctx.waitFor(
    chooserOrLoadedDashboardExpression(),
    { timeoutMs: 60_000, label: "chooser or loaded dashboard after sign-in" },
  );

  const chooserVisible = await ctx.eval(`Boolean(document.querySelector('[data-testid="org-chooser-root"]'))`);
  if (!chooserVisible) {
    await forceChooser(ctx);
    return;
  }

  await waitForChooser(ctx);
}

async function chooserVisualState(ctx) {
  return ctx.eval(`(() => {
    const root = document.querySelector('[data-testid="org-chooser-root"]');
    const background = document.querySelector('[data-testid="org-chooser-background"]');
    const foreground = document.querySelector('[data-testid="org-chooser-foreground"]');
    const list = document.querySelector('[data-testid="org-chooser-list"]');
    const actions = document.querySelector('[data-testid="org-chooser-actions"]');
    const rootStyle = root ? getComputedStyle(root) : null;
    const backgroundStyle = background ? getComputedStyle(background) : null;
    const foregroundStyle = foreground ? getComputedStyle(foreground) : null;
    const listStyle = list ? getComputedStyle(list) : null;
    const backgroundRect = background?.getBoundingClientRect();
    const foregroundRect = foreground?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();

    return {
      path: window.location.pathname,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rootMinHeight: rootStyle?.minHeight ?? null,
      rootOverflowY: rootStyle?.overflowY ?? null,
      rootBackgroundColor: rootStyle?.backgroundColor ?? null,
      backgroundAriaHidden: background?.getAttribute('aria-hidden') ?? null,
      backgroundPointerEvents: backgroundStyle?.pointerEvents ?? null,
      backgroundOpacity: backgroundStyle?.opacity ?? null,
      backgroundPosition: backgroundStyle?.position ?? null,
      backgroundZIndex: backgroundStyle?.zIndex ?? null,
      backgroundCanvasCount: background?.querySelectorAll('canvas').length ?? 0,
      rootCanvasCount: root?.querySelectorAll('canvas').length ?? 0,
      backgroundCoversViewport: Boolean(backgroundRect && backgroundRect.width >= window.innerWidth && backgroundRect.height >= window.innerHeight),
      foregroundZIndex: foregroundStyle?.zIndex ?? null,
      foregroundOpacity: foregroundStyle?.opacity ?? null,
      foregroundWithinViewport: Boolean(foregroundRect && foregroundRect.left >= 0 && foregroundRect.right <= window.innerWidth + 1),
      listBackgroundColor: listStyle?.backgroundColor ?? null,
      listOpacity: listStyle?.opacity ?? null,
      listWithinViewport: Boolean(listRect && listRect.left >= 0 && listRect.right <= window.innerWidth + 1),
      actionsText: actions?.innerText ?? '',
      documentText: document.body.innerText,
    };
  })()`);
}

async function orgListState(ctx) {
  return ctx.eval(`(() => {
    const list = document.querySelector('[data-testid="org-chooser-list"]');
    const buttons = [...(list?.querySelectorAll('button') ?? [])].map((button) => ({
      text: button.innerText,
      disabled: button.disabled,
      rect: (() => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      })(),
    }));
    const metadataRows = buttons.filter((button) => {
      const text = button.text.replace(/\\s+/g, ' ');
      const bulletIndex = text.indexOf('•');
      const hasRole = bulletIndex > 0 && text.slice(0, bulletIndex).trim().length > 0;
      return hasRole && /\\d+ members?/.test(text);
    });

    return {
      count: buttons.length,
      metadataCount: metadataRows.length,
      firstRowText: buttons[0]?.text ?? null,
      targetRowText: buttons.find((button) => button.text.includes(${JSON.stringify(state.targetOrg?.name ?? "")}))?.text ?? null,
      allEnabled: buttons.every((button) => !button.disabled),
    };
  })()`);
}

async function selectTargetOrg(ctx) {
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      if (text.includes('Dashboard') && !document.querySelector('[data-testid="org-chooser-root"]')) return true;
      const button = [...document.querySelectorAll('[data-testid="org-chooser-list"] button')]
        .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(state.targetOrg?.name ?? "")}));
      button?.click();
      return false;
    })()`,
    { timeoutMs: 60_000, label: `select ${state.targetOrg?.name ?? "organization"}` },
  );
}

export default {
  id: "org-chooser-background",
  title: "Organization chooser uses a restrained Dithering background without sacrificing readability",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MULTI_ORG"],
  steps: [
    {
      name: "Setup: seeded user has a real multi-org chooser",
      run: async (ctx) => {
        await ensureMultiOrgAccount(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The real organization chooser opens on a calm Dithering background", {
          voiceover: vo[0],
          action: async () => {
            await openFreshChooser(ctx);
          },
          assert: async () => {
            await ctx.expectText("Choose an organization");
            const visual = await chooserVisualState(ctx);
            ctx.assert(visual.backgroundCanvasCount === 1 && visual.rootCanvasCount === 1, `Expected exactly one chooser shader canvas: ${JSON.stringify(visual)}`);
            ctx.assert(visual.backgroundCoversViewport, `Background did not cover the viewport: ${JSON.stringify(visual)}`);
            ctx.assert(visual.rootBackgroundColor === "rgb(15, 29, 49)", `Unexpected root background color: ${JSON.stringify(visual)}`);
          },
          screenshot: {
            name: "chooser-calm-background",
            claim: "The organization chooser opens on the new navy Dithering treatment with the chooser content in front.",
            requireText: ["Choose an organization", state.targetOrg?.name ?? EVAL_ORG_NAME],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The decorative texture is separate and low-opacity while the list stays readable", {
          voiceover: vo[1],
          action: async () => {
            await waitForChooser(ctx);
          },
          assert: async () => {
            const visual = await chooserVisualState(ctx);
            const opacity = Number.parseFloat(visual.backgroundOpacity ?? "1");
            ctx.assert(visual.backgroundAriaHidden === "true", `Background is not aria-hidden: ${JSON.stringify(visual)}`);
            ctx.assert(visual.backgroundPointerEvents === "none", `Background can receive pointer events: ${JSON.stringify(visual)}`);
            ctx.assert(visual.backgroundPosition === "fixed" && visual.backgroundZIndex === "0" && visual.foregroundZIndex === "10", `Background/foreground stacking changed: ${JSON.stringify(visual)}`);
            ctx.assert(opacity > 0 && opacity <= 0.12, `Background opacity is not restrained: ${JSON.stringify(visual)}`);
            ctx.assert(visual.foregroundOpacity === "1" && visual.listOpacity === "1", `Foreground/list opacity should stay fully legible: ${JSON.stringify(visual)}`);
            ctx.assert(visual.listBackgroundColor === "rgb(255, 255, 255)", `Org list is not an opaque white surface: ${JSON.stringify(visual)}`);
          },
          screenshot: {
            name: "chooser-readable-list",
            claim: "The low-opacity decorative shader sits behind a crisp white organization list.",
            requireText: ["Choose an organization", "member"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Role and member metadata are readable, and selecting an org continues to the dashboard", {
          voiceover: vo[2],
          action: async () => {
            await waitForChooser(ctx);
            const list = await orgListState(ctx);
            ctx.assert(list.count >= 2, `Chooser did not show multiple organizations: ${JSON.stringify(list)}`);
            ctx.assert(list.metadataCount >= 1, `Chooser rows did not expose role/member metadata: ${JSON.stringify(list)}`);
            ctx.assert(Boolean(list.targetRowText), `Target organization row was missing: ${JSON.stringify(list)}`);
            await selectTargetOrg(ctx);
          },
          assert: async () => {
            await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
            const chooserStillVisible = await ctx.eval(`Boolean(document.querySelector('[data-testid="org-chooser-root"]'))`);
            ctx.assert(!chooserStillVisible, "The chooser remained visible after selecting an organization.");
            const pathname = await ctx.eval("window.location.pathname");
            ctx.assert(pathname === "/dashboard", `Selecting an organization landed on ${pathname} instead of /dashboard.`);
          },
          screenshot: {
            name: "org-selected-dashboard",
            claim: "After the user picks an organization, Den continues into the dashboard.",
            requireText: ["Dashboard"],
            rejectText: ["Choose an organization", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The actions and readable list remain intact on a small screen", {
          voiceover: vo[3],
          action: async () => {
            await applyViewport(ctx, 390, 780, true);
            await forceChooser(ctx);
          },
          assert: async () => {
            const visual = await chooserVisualState(ctx);
            ctx.assert(visual.viewportWidth <= 430, `Mobile viewport was not applied: ${JSON.stringify(visual)}`);
            ctx.assert(visual.rootOverflowY === "auto" && typeof visual.rootMinHeight === "string" && visual.rootMinHeight.endsWith("px"), `Chooser shell is not scroll-safe: ${JSON.stringify(visual)}`);
            ctx.assert(visual.foregroundWithinViewport && visual.listWithinViewport, `Chooser content overflowed the mobile viewport: ${JSON.stringify(visual)}`);
            ctx.assert(visual.listBackgroundColor === "rgb(255, 255, 255)", `Mobile org list is not readable white: ${JSON.stringify(visual)}`);
            ctx.assert(visual.actionsText.includes("Create or join") && visual.actionsText.includes("Sign out"), `Mobile actions are not visible: ${JSON.stringify(visual)}`);
          },
          screenshot: {
            name: "chooser-mobile-actions",
            claim: "On a phone-sized viewport, the same restrained background stays behind the readable chooser and its account actions.",
            requireText: ["Choose an organization", "Create or join", "Sign out"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
