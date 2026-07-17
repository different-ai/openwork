import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "new-signin-flow";
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "http://localhost:3005").replace(/\/+$/, "");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

export default {
  id: FLOW_ID,
  title: "Den Web resolves sign-in from email first",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Email-first start",
      run: async (ctx) => {
        await ctx.prove("The root auth page starts with only email and Next", {
          voiceover: vo[0],
          action: async () => {
            await openSignedOutRoot(ctx);
          },
          assert: async () => {
            await ctx.expectText("Start using OpenWork", { timeoutMs: 30_000 });
            const actual = await readAuthSurface(ctx);
            ctx.assert(actual.emailInputs === 1, `Expected one email field, got ${JSON.stringify(actual)}`);
            ctx.assert(actual.passwordInputs === 0, `Expected no password field, got ${JSON.stringify(actual)}`);
            ctx.assert(actual.buttons.length === 1 && actual.buttons[0] === "Next", `Expected only Next button, got ${JSON.stringify(actual.buttons)}`);
            ctx.assert(!actual.text.includes("Create account"), "Create account should not appear before email lookup.");
            ctx.assert(!actual.text.includes("Continue with Google"), "Google should not appear before email lookup.");
          },
          screenshot: {
            name: "email-first-start",
            requireText: ["Start using OpenWork", "EMAIL", "Next"],
            rejectText: ["Password", "Continue with Google", "Create account"],
          },
        });
      },
    },
    {
      name: "Backend decides next step",
      run: async (ctx) => {
        await ctx.prove("Next calls login-options for the entered email and renders the returned step", {
          voiceover: vo[1],
          action: async () => {
            await openSignedOutRoot(ctx);
            await installLoginOptionsMock(ctx, { nextStep: "password" });
            await fillEmailAndNext(ctx, "pat@acme.test");
            await ctx.waitFor("document.body.innerText.includes('Enter your password.')", {
              timeoutMs: 30_000,
              label: "password step after login-options response",
            });
          },
          assert: async () => {
            const requests = await ctx.eval("window.__openworkLoginOptionRequests ?? []");
            ctx.assert(requests.length === 1, `Expected one login-options request, got ${JSON.stringify(requests)}`);
            ctx.assert(requests[0]?.endsWith("email=pat%40acme.test"), `Expected request to include the typed email, got ${JSON.stringify(requests)}`);
            const actual = await readAuthSurface(ctx);
            ctx.assert(actual.text.includes("Enter your password."), `Expected password step, got ${actual.text}`);
          },
          screenshot: {
            name: "backend-routes-to-step",
            requireText: ["Enter your password.", "Sign in as pat@acme.test.", "PASSWORD", "Sign in"],
            rejectText: ["Sign in with Google", "Sign in with SSO", "Create your account."],
          },
        });
      },
    },
    {
      name: "SSO route",
      run: async (ctx) => {
        await ctx.prove("An SSO-managed account only sees Sign in with SSO", {
          voiceover: vo[2],
          action: async () => {
            await openSignedOutRoot(ctx);
            await installLoginOptionsMock(ctx, {
              nextStep: "sso",
              organizationSlug: "acme",
              signInPath: "/sso/acme",
              signInUrl: `${DEN_WEB_URL}/sso/acme`,
            });
            await fillEmailAndNext(ctx, "sso@acme.test");
            await ctx.waitFor("document.body.innerText.includes('Sign in with SSO.')", {
              timeoutMs: 30_000,
              label: "SSO step",
            });
          },
          assert: async () => {
            const actual = await readAuthSurface(ctx);
            ctx.assert(actual.buttons.length === 1 && actual.buttons[0] === "Sign in with SSO", `Expected only SSO button, got ${JSON.stringify(actual.buttons)}`);
            ctx.assert(actual.passwordInputs === 0, `Expected no password field, got ${JSON.stringify(actual)}`);
            ctx.assert(!actual.text.includes("Google"), "Google should not appear on SSO step.");
          },
          screenshot: {
            name: "sso-only-step",
            requireText: ["Sign in with SSO.", "sso@acme.test is managed by your organization.", "Sign in with SSO"],
            rejectText: ["Sign in with Google", "PASSWORD", "Create your account."],
          },
        });
      },
    },
    {
      name: "Google route",
      run: async (ctx) => {
        await ctx.prove("A Google account only sees Sign in with Google", {
          voiceover: vo[3],
          action: async () => {
            await openSignedOutRoot(ctx);
            await installLoginOptionsMock(ctx, { nextStep: "google" });
            await fillEmailAndNext(ctx, "google@acme.test");
            await ctx.waitFor("document.body.innerText.includes('Sign in with Google')", {
              timeoutMs: 30_000,
              label: "Google step",
            });
          },
          assert: async () => {
            const actual = await readAuthSurface(ctx);
            ctx.assert(actual.buttons.length === 1 && actual.buttons[0] === "Sign in with Google", `Expected only Google button, got ${JSON.stringify(actual.buttons)}`);
            ctx.assert(actual.passwordInputs === 0, `Expected no password field, got ${JSON.stringify(actual)}`);
            ctx.assert(!actual.text.includes("SSO"), "SSO should not appear on Google step.");
          },
          screenshot: {
            name: "google-only-step",
            requireText: ["Welcome back.", "Use Google to continue with this account.", "Sign in with Google"],
            rejectText: ["Sign in with SSO", "PASSWORD", "Create your account."],
          },
        });
      },
    },
    {
      name: "Password route",
      run: async (ctx) => {
        await ctx.prove("A password account sees the password field and Sign in", {
          voiceover: vo[4],
          action: async () => {
            await openSignedOutRoot(ctx);
            await installLoginOptionsMock(ctx, { nextStep: "password" });
            await fillEmailAndNext(ctx, "password@acme.test");
            await ctx.waitFor("document.body.innerText.includes('Enter your password.')", {
              timeoutMs: 30_000,
              label: "password step",
            });
          },
          assert: async () => {
            const actual = await readAuthSurface(ctx);
            ctx.assert(actual.passwordInputs === 1, `Expected one password field, got ${JSON.stringify(actual)}`);
            ctx.assert(actual.buttons.includes("Sign in"), `Expected Sign in button, got ${JSON.stringify(actual.buttons)}`);
            ctx.assert(!actual.text.includes("Sign in with Google"), "Google should not appear on password step.");
          },
          screenshot: {
            name: "password-step",
            requireText: ["Enter your password.", "Sign in as password@acme.test.", "PASSWORD", "Sign in"],
            rejectText: ["Sign in with Google", "Sign in with SSO", "Create your account."],
          },
        });
      },
    },
    {
      name: "New account route",
      run: async (ctx) => {
        await ctx.prove("A new email sees the create-account form with name, Google, password, and Sign up", {
          voiceover: vo[5],
          action: async () => {
            await openSignedOutRoot(ctx);
            await installLoginOptionsMock(ctx, { nextStep: "new_account" });
            await fillEmailAndNext(ctx, "new@acme.test");
            await ctx.waitFor("document.body.innerText.includes('Create your account.')", {
              timeoutMs: 30_000,
              label: "new account step",
            });
          },
          assert: async () => {
            const actual = await readAuthSurface(ctx);
            ctx.assert(actual.emailInputs === 1, `Expected one email field, got ${JSON.stringify(actual)}`);
            ctx.assert(actual.passwordInputs === 1, `Expected one password field, got ${JSON.stringify(actual)}`);
            ctx.assert(actual.text.includes("NAME"), "Expected Name field on new account form.");
            ctx.assert(actual.buttons.includes("Sign up with Google"), `Expected Google sign-up button, got ${JSON.stringify(actual.buttons)}`);
            ctx.assert(actual.buttons.includes("Sign up"), `Expected Sign up button, got ${JSON.stringify(actual.buttons)}`);
          },
          screenshot: {
            name: "new-account-step",
            requireText: ["Create your account.", "EMAIL", "NAME", "Sign up with Google", "PASSWORD", "Sign up"],
            rejectText: ["Sign in with SSO", "Sign in with Google"],
          },
        });
      },
    },
  ],
};

async function openSignedOutRoot(ctx) {
  await ctx.eval(`(() => {
    window.location.href = ${JSON.stringify(DEN_WEB_URL)};
    return true;
  })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "den-web loaded" });
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
    `(() => document.body.innerText.includes('Start using OpenWork') && Boolean(document.querySelector('input[type="email"]')))()`,
    { timeoutMs: 30_000, label: "email-first auth panel" },
  );
}

async function installLoginOptionsMock(ctx, responsePayload) {
  await ctx.eval(`((payload) => {
    const originalFetch = window.fetch.bind(window);
    window.__openworkLoginOptionRequests = [];
    window.fetch = (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname === '/v1/auth/login-options' || url.pathname === '/api/den/v1/auth/login-options') {
        window.__openworkLoginOptionRequests.push(url.pathname + url.search);
        return Promise.resolve(new Response(JSON.stringify({ email: url.searchParams.get('email') ?? '', ...payload }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return originalFetch(input, init);
    };
    return true;
  })(${JSON.stringify(responsePayload)})`);
}

async function fillEmailAndNext(ctx, email) {
  await ctx.fill('input[type="email"]', email);
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Next');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, "Could not find the Next button.");
}

async function readAuthSurface(ctx) {
  return ctx.eval(`(() => {
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      text: document.body.innerText,
      buttons,
      emailInputs: document.querySelectorAll('input[type="email"]').length,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
    };
  })()`);
}
