import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "simple-cloud-landing";
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || "http://localhost:3005").replace(/\/+$/, "");
const TEST_EMAIL = "pat@openwork.test";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
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
  });
}

async function openSignedOutRoot(ctx) {
  await ctx.eval(`(() => {
    window.location.href = ${JSON.stringify(DEN_WEB_URL)};
    return true;
  })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Den web loaded" });
  await ctx.eval(`(() => {
    window.localStorage.removeItem('openwork:web:auth-token');
    window.sessionStorage.clear();
    return fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(() => true)
      .catch(() => true);
  })()`, { awaitPromise: true });
  await ctx.eval(`(() => {
    window.location.href = ${JSON.stringify(DEN_WEB_URL)};
    return true;
  })()`);
  await ctx.waitFor(
    `document.body.innerText.includes('Start using OpenWork') && Boolean(document.querySelector('input[type="email"]'))`,
    { timeoutMs: 30_000, label: "simple email-first auth panel" },
  );
}

async function installDeferredLoginOptionsMock(ctx, responsePayload) {
  await ctx.eval(`((payload) => {
    const originalFetch = window.__openworkOriginalFetch ?? window.fetch.bind(window);
    window.__openworkOriginalFetch = originalFetch;
    window.__openworkLoginOptionRequests = [];
    window.__openworkResolveLoginOptions = null;
    window.fetch = (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname === '/v1/auth/login-options' || url.pathname === '/api/den/v1/auth/login-options') {
        window.__openworkLoginOptionRequests.push(url.pathname + url.search);
        return new Promise((resolve) => {
          window.__openworkResolveLoginOptions = () => {
            resolve(new Response(JSON.stringify({ email: url.searchParams.get('email') ?? '', ...payload }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }));
            return true;
          };
        });
      }
      return originalFetch(input, init);
    };
    return true;
  })(${JSON.stringify(responsePayload)})`);
}

async function fillEmailAndClickNext(ctx) {
  await ctx.fill('input[type="email"]', TEST_EMAIL);
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Next');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, "Could not find the Next button.");
}

async function resolveLoginOptions(ctx) {
  const resolved = await ctx.eval(`(() => {
    if (typeof window.__openworkResolveLoginOptions !== 'function') return false;
    return window.__openworkResolveLoginOptions();
  })()`);
  ctx.assert(resolved, "Login-options mock was not waiting to resolve.");
}

async function readLandingState(ctx) {
  return ctx.eval(`(() => {
    const rectFor = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: style.display,
        visibility: style.visibility,
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      };
    };
    const visibleButtons = [...document.querySelectorAll('button')]
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const visual = document.querySelector('[data-testid="auth-landing-visual"]');
    const mobileBrand = document.querySelector('[data-testid="auth-landing-mobile-brand"]');
    return {
      text: document.body.innerText,
      url: location.href,
      hostname: location.hostname,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      frame: rectFor(document.querySelector('[data-testid="auth-landing-frame"]')),
      visual: rectFor(visual),
      form: rectFor(document.querySelector('[data-testid="auth-landing-form"]')),
      mobileBrand: rectFor(mobileBrand),
      mobileBrandText: mobileBrand?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      visualCanvasCount: visual?.querySelectorAll('canvas').length ?? 0,
      emailInputs: document.querySelectorAll('input[type="email"]').length,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      visibleButtons,
    };
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Den web root auth landing keeps a focused split layout and email-first behavior",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Focused split layout",
      run: async (ctx) => {
        await ctx.prove("The root auth page opens as a compact split card with only the shader visual and account form", {
          voiceover: vo[0],
          action: async () => {
            await applyViewport(ctx, 1280, 900, false);
            await openSignedOutRoot(ctx);
            await ctx.waitFor(`Boolean(document.querySelector('[data-testid="auth-landing-visual"] canvas'))`, {
              timeoutMs: 30_000,
              label: "desktop shader canvas",
            });
          },
          assert: async () => {
            const state = await readLandingState(ctx);
            recordAssertion(ctx, "The frame is centered and bounded to 600px", Boolean(state.frame) && state.frame.width <= 604 && Math.abs((state.frame.left + state.frame.right) / 2 - state.viewport.width / 2) <= 4, state);
            recordAssertion(ctx, "Desktop shows the visual panel and form side by side, with the form wider", Boolean(state.visual?.visible && state.form?.visible) && state.form.width > state.visual.width && state.visual.left < state.form.left, state);
            recordAssertion(ctx, "The left panel has exactly one shader canvas and the old marketing content is absent", state.visualCanvasCount === 1 && !state.text.includes("OpenWork Cloud") && !state.text.includes("One setup, every seat.") && !state.text.includes("Shared config"), state);
            recordAssertion(ctx, "The initial form is email-first with one Next button", state.emailInputs === 1 && state.passwordInputs === 0 && state.visibleButtons.length === 1 && state.visibleButtons[0] === "Next", state);
          },
          screenshot: {
            name: "desktop-focused-split-layout",
            requireText: ["Start using OpenWork", "EMAIL", "Next"],
            rejectText: ["OpenWork Cloud", "One setup, every seat.", "Shared config", "Cloud agents", "Your models"],
          },
        });
      },
    },
    {
      name: "Email and Next action",
      run: async (ctx) => {
        await ctx.prove("The only required action is entering an email and selecting Next", {
          voiceover: vo[1],
          action: async () => {
            await installDeferredLoginOptionsMock(ctx, { nextStep: "password" });
            await fillEmailAndClickNext(ctx);
            await ctx.waitFor("document.body.innerText.includes('Checking...')", {
              timeoutMs: 10_000,
              label: "checking login options",
            });
          },
          assert: async () => {
            const requests = await ctx.eval("window.__openworkLoginOptionRequests ?? []");
            const state = await readLandingState(ctx);
            recordAssertion(ctx, "Next calls login-options exactly once with the entered email", requests.length === 1 && requests[0]?.endsWith("email=pat%40openwork.test"), { requests, state });
            recordAssertion(ctx, "No extra sign-in choices appear during the email-first action", state.visibleButtons.length === 1 && state.visibleButtons[0] === "Checking..." && !state.text.includes("Continue with Google") && !state.text.includes("Create account"), state);
          },
          screenshot: {
            name: "email-next-action",
            requireText: ["Start using OpenWork", "EMAIL", "Checking..."],
            rejectText: ["Password", "Continue with Google", "Create account"],
          },
        });
      },
    },
    {
      name: "Preserved existing sign-in step",
      run: async (ctx) => {
        await ctx.prove("The backend-selected existing sign-in step renders without completing external auth", {
          voiceover: vo[2],
          action: async () => {
            await resolveLoginOptions(ctx);
            await ctx.waitFor("document.body.innerText.includes('Enter your password.')", {
              timeoutMs: 30_000,
              label: "password step after login-options response",
            });
          },
          assert: async () => {
            const state = await readLandingState(ctx);
            recordAssertion(ctx, "The password step is selected for the existing email", state.passwordInputs === 1 && state.text.includes(`Sign in as ${TEST_EMAIL}.`) && state.visibleButtons.includes("Sign in"), state);
            recordAssertion(ctx, "The flow stays inside Den web and does not complete external auth", state.hostname.length > 0 && !state.text.includes("Choose an account"), state);
          },
          screenshot: {
            name: "existing-password-step",
            requireText: ["Enter your password.", `Sign in as ${TEST_EMAIL}.`, "PASSWORD", "Sign in"],
            rejectText: ["Sign in with Google", "Sign in with SSO", "Create your account."],
          },
        });
      },
    },
    {
      name: "Responsive mobile state",
      run: async (ctx) => {
        await ctx.prove("On mobile the decorative panel disappears and the compact OpenWork logo leads the form", {
          voiceover: vo[3],
          action: async () => {
            await applyViewport(ctx, 390, 820, true);
            await openSignedOutRoot(ctx);
          },
          assert: async () => {
            const state = await readLandingState(ctx);
            recordAssertion(ctx, "The decorative shader panel is hidden on mobile", Boolean(state.visual) && state.visual.visible === false, state);
            recordAssertion(ctx, "The compact OpenWork mobile brand and account form are centered", Boolean(state.mobileBrand?.visible && state.form?.visible && state.frame) && state.mobileBrandText.includes("OpenWork") && state.frame.width <= state.viewport.width && Math.abs((state.frame.left + state.frame.right) / 2 - state.viewport.width / 2) <= 4, state);
            recordAssertion(ctx, "Mobile remains the same email-first form", state.emailInputs === 1 && state.passwordInputs === 0 && state.visibleButtons.length === 1 && state.visibleButtons[0] === "Next", state);
          },
          screenshot: {
            name: "mobile-centered-form",
            requireText: ["OpenWork", "Start using OpenWork", "EMAIL", "Next"],
            rejectText: ["OpenWork Cloud", "One setup, every seat.", "Shared config", "Cloud agents", "Your models"],
          },
        });
      },
    },
  ],
};
