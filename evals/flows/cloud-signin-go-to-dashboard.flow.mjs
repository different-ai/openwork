/**
 * Cloud sign-in desktop handoff escape hatch: the signed-in card's
 * "Go to dashboard" button resolves a dashboard route even while
 * ?desktopAuth=1 is pending.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("cloud-signin-go-to-dashboard");

const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function goTo(ctx, path) {
  await ctx.eval(`location.assign(${JSON.stringify(`${DEN_WEB_URL}${path}`)})`);
  await sleep(1_500);
}

async function uiSignIn(ctx, email, password) {
  await goTo(ctx, "/");
  // Idempotency: a previous run (or frame) may have left someone signed in,
  // in which case "/" redirects straight to the dashboard.
  if (await ctx.eval("location.pathname.startsWith('/dashboard')")) {
    await resetSession(ctx);
    await goTo(ctx, "/");
  }
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "auth screen" });
  // Ensure the sign-in mode is selected (the screen defaults to sign-up).
  await ctx.eval(`(() => {
    const tab = [...document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Sign in');
    tab?.click();
    return true;
  })()`);
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });
  const filled = await ctx.eval(`(() => {
    const setNative = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const email = document.querySelector('input[type="email"], input[name="email"]');
    const password = document.querySelector('input[type="password"]');
    if (!email || !password) return false;
    setNative(email, ${JSON.stringify(email)});
    setNative(password, ${JSON.stringify(password)});
    const buttons = [...document.querySelectorAll('button')].filter((el) => el.textContent.trim() === 'Sign in' && !el.disabled);
    buttons[buttons.length - 1]?.click();
    return buttons.length > 0;
  })()`);
  ctx.assert(filled, "Could not fill and submit the sign-in form.");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
  await ctx.waitFor("Boolean(document.querySelector('nav'))", { timeoutMs: 30_000, label: "sidebar rendered" });
  await sleep(1_000);
}

async function resetSession(ctx) {
  // Setup plumbing, not the demoed claim: clear a leftover session the same
  // UI-independent way the app's own signOut does (POST /api/auth/sign-out
  // with the stored bearer token, then drop the token).
  await ctx.eval(
    `(async () => {
      const token = localStorage.getItem("openwork:web:auth-token");
      try {
        await fetch("/api/auth/sign-out", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: "Bearer " + token } : {}),
          },
          body: "{}",
        });
      } catch {}
      localStorage.removeItem("openwork:web:auth-token");
      return true;
    })()`,
    { awaitPromise: true },
  );
}

export default {
  id: "cloud-signin-go-to-dashboard",
  title: "Cloud sign-in: \"Go to dashboard\" navigates while a desktop handoff is pending",
  kind: "user-facing",
  spec: "evals/voiceovers/cloud-signin-go-to-dashboard.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Landing on the sign-in page mid desktop handoff shows the signed-in card, not a password form", {
          voiceover: vo[0],
          action: async () => {
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await goTo(ctx, "/?desktopAuth=1");
          },
          assert: async () => {
            await ctx.waitFor(`(() => {
              const text = document.body.innerText;
              return text.includes("You're signed in.") && text.includes("Go to dashboard") && text.includes("Open OpenWork") && location.pathname === "/";
            })()`, { timeoutMs: 30_000, label: "signed-in desktop handoff card" });
          },
          screenshot: {
            name: "signed-in-handoff-card",
            claim: "The signed-in handoff card appears with the dashboard escape hatch.",
            requireText: ["You're signed in.", "Go to dashboard", "Open OpenWork"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Clicking Go to dashboard navigates to the org dashboard", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("Go to dashboard", { selector: "button", timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 20_000, label: "dashboard route after Go to dashboard" });
            await ctx.waitFor("document.body.innerText.includes('Dashboard')", { timeoutMs: 20_000, label: "dashboard nav rendered" });
          },
          screenshot: {
            name: "dashboard-after-click",
            claim: "The Go to dashboard button lands Alex on the org dashboard.",
            requireText: ["Dashboard"],
            rejectText: ["You're signed in.", "Something went wrong"],
          },
        });
      },
    },
  ],
};
