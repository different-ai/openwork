import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/on-sign-in-verify-name.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("on-sign-in-verify-name");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
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

async function resetSession(ctx) {
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

async function uiSignIn(ctx) {
  await goTo(ctx, "/");
  if (await ctx.eval("location.pathname.startsWith('/dashboard')")) {
    await resetSession(ctx);
    await goTo(ctx, "/");
  }

  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "auth screen" });
  await ctx.eval(`(() => {
    const tab = [...document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Sign in');
    tab?.click();
    return true;
  })()`);
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });

  const submitted = await ctx.eval(`(() => {
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
    setNative(email, ${JSON.stringify(ADMIN_EMAIL)});
    setNative(password, ${JSON.stringify(ADMIN_PASSWORD)});
    const buttons = [...document.querySelectorAll('button')].filter((el) => el.textContent.trim() === 'Sign in' && !el.disabled);
    buttons[buttons.length - 1]?.click();
    return buttons.length > 0;
  })()`);
  ctx.assert(submitted, "Could not fill and submit the sign-in form.");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
  await ctx.waitFor("Boolean(document.querySelector('nav'))", { timeoutMs: 30_000, label: "dashboard sidebar rendered" });
}

async function updateProfileName(ctx, firstName, lastName) {
  const result = await ctx.eval(
    `(async () => {
      const token = localStorage.getItem("openwork:web:auth-token");
      const response = await fetch(${JSON.stringify(`${DEN_API_URL}/v1/me/profile`)}, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify({ firstName: ${JSON.stringify(firstName)}, lastName: ${JSON.stringify(lastName)} }),
      });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    })()`,
    { awaitPromise: true },
  );
  ctx.assert(result.ok, `Profile setup failed with ${result.status}.`);
}

async function readProfileName(ctx) {
  const result = await ctx.eval(
    `(async () => {
      const token = localStorage.getItem("openwork:web:auth-token");
      const response = await fetch(${JSON.stringify(`${DEN_API_URL}/v1/me`)}, {
        method: "GET",
        credentials: "include",
        headers: {
          "accept": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
      });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, name: body?.user?.name ?? null };
    })()`,
    { awaitPromise: true },
  );
  ctx.assert(result.ok, `Profile read failed with ${result.status}.`);
  return result.name;
}

async function waitForProfileDialog(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return text.includes("User Profile") && text.includes("Change how your name appears in the organization");
  })()`, { timeoutMs: 20_000, label: "default-name profile dialog" });
}

async function selectProfileField(ctx, autoComplete) {
  const selected = await ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(`input[autocomplete="${autoComplete}"]`)});
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  })()`);
  ctx.assert(selected, `Could not select ${autoComplete}.`);
  await sleep(250);
}

async function fillProfileField(ctx, autoComplete, value) {
  const filled = await ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(`input[autocomplete="${autoComplete}"]`)});
    if (!input) return false;
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  ctx.assert(filled, `Could not fill ${autoComplete}.`);
}

async function clickDialogButton(ctx, label) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(label)} && !el.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, `Could not click ${label}.`);
}

export default {
  id: "on-sign-in-verify-name",
  title: "Default-name users are prompted to update their profile from the dashboard",
  kind: "user-facing",
  spec: "evals/voiceovers/on-sign-in-verify-name.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A signed-in dashboard user with the default name sees the User Profile dialog", {
          voiceover: vo[0],
          action: async () => {
            await uiSignIn(ctx);
            await updateProfileName(ctx, "OpenWork", "User");
            await goTo(ctx, "/dashboard");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 20_000, label: "dashboard route" });
            await waitForProfileDialog(ctx);
          },
          screenshot: {
            name: "default-name-dashboard-dialog",
            claim: "The dashboard opens a User Profile dialog for the default OpenWork User name.",
            requireText: ["User Profile", "Change how your name appears in the organization"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The dialog shows first and last name fields with Save disabled until a change", {
          voiceover: vo[1],
          action: async () => {
            await waitForProfileDialog(ctx);
            await selectProfileField(ctx, "given-name");
          },
          assert: async () => {
            const state = await ctx.eval(`(() => {
              const first = document.querySelector('input[autocomplete="given-name"]');
              const last = document.querySelector('input[autocomplete="family-name"]');
              const save = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Save');
              return { first: first?.value ?? null, last: last?.value ?? null, saveDisabled: save?.disabled === true };
            })()`);
            ctx.assert(state.first === "OpenWork", "First name is prefilled from the default name.");
            ctx.assert(state.last === "User", "Last name is prefilled from the default name.");
            ctx.assert(state.saveDisabled, "Save is disabled before the user changes a field.");
          },
          screenshot: {
            name: "profile-dialog-disabled-save",
            claim: "The profile dialog asks for first and last name and Save starts disabled.",
            requireText: ["First name", "Last name", "Save", "Cancel"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Changing either name field enables Save", {
          voiceover: vo[2],
          action: async () => {
            await fillProfileField(ctx, "given-name", "Maya");
            await fillProfileField(ctx, "family-name", "Rivera");
          },
          assert: async () => {
            const saveEnabled = await ctx.eval(`(() => {
              const save = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Save');
              return Boolean(save && !save.disabled);
            })()`);
            ctx.assert(saveEnabled, "Save is enabled after changing the profile fields.");
          },
          screenshot: {
            name: "profile-dialog-save-enabled",
            claim: "Editing the fields enables Save.",
            requireText: ["User Profile", "Save", "Cancel"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Saving writes the new display name and returns to the dashboard", {
          voiceover: vo[3],
          action: async () => {
            await clickDialogButton(ctx, "Save");
          },
          assert: async () => {
            await ctx.waitFor("!document.body.innerText.includes('User Profile')", { timeoutMs: 20_000, label: "profile dialog closes after save" });
            const name = await readProfileName(ctx);
            ctx.assert(name === "Maya Rivera", "The user table stores the saved profile name.");
          },
          screenshot: {
            name: "dashboard-after-profile-save",
            claim: "After Save, the dialog closes and the dashboard remains visible.",
            requireText: ["Dashboard"],
            rejectText: ["User Profile", "Could not update your profile"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Cancel closes the dialog without changing the default name during that dashboard visit", {
          voiceover: vo[4],
          action: async () => {
            await updateProfileName(ctx, "OpenWork", "User");
            await goTo(ctx, "/dashboard");
            await waitForProfileDialog(ctx);
            await clickDialogButton(ctx, "Cancel");
            await sleep(1_000);
          },
          assert: async () => {
            await ctx.waitFor("!document.body.innerText.includes('User Profile')", { timeoutMs: 10_000, label: "profile dialog remains dismissed" });
            const name = await readProfileName(ctx);
            ctx.assert(name === "OpenWork User", "Cancel leaves the stored default name unchanged.");
          },
          screenshot: {
            name: "dashboard-after-profile-cancel",
            claim: "Cancel dismisses the prompt for the current dashboard visit without saving.",
            requireText: ["Dashboard"],
            rejectText: ["User Profile", "Could not update your profile"],
          },
        });
      },
    },
  ],
};
