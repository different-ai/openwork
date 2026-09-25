import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";

function itemId(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.item) || typeof body.item.id !== "string") {
    throw new Error("Synthetic skill setup returned no item ID");
  }
  return body.item.id;
}

export async function skillEditorReauth(seed: Seed) {
  const den = await seed.den({ org: { name: "Skill recovery lab" } });
  const plugin = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: "Recovery plugin", orgWide: true }),
  });
  const pluginId = itemId(plugin.body);
  const created = await seed.api(den.admin, "/v1/config-objects", {
    method: "POST",
    body: JSON.stringify({ type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: {
      rawSourceText: "---\nname: synthetic-recovery\ndescription: Synthetic recovery instructions\n---\n\nOriginal instructions.",
    } }),
  });
  const skillId = itemId(created.body);
  const web = await seed.web({ den, signedInAs: den.admin,
    startPath: `/dashboard/plugins/${pluginId}/skills/${skillId}/edit`, headless: true });
  return {
    den, web, skillId,
    // Transport fault: only skill writes receive a deterministic step-up response.
    // Successful writes and password verification still reach the real Den API.
    async expire() {
      await seed.evalIn(web, `(() => {
        const originalFetch = window.fetch.bind(window);
        window.__skillRecovery = { attempts: 0, writes: 0, verified: false, popupAttempts: 0 };
        window.open = () => { window.__skillRecovery.popupAttempts++; return null; };
        window.fetch = async (...args) => {
          const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.origin).pathname;
          const state = window.__skillRecovery;
          if (path.endsWith('/versions') && args[1]?.method === 'POST') {
            state.attempts++;
            if (!state.verified) return new Response(JSON.stringify({ error: 'reauth', reason: 'fresh_auth_required', message: 'Confirm your identity to continue.' }), { status: 403 });
            const response = await originalFetch(...args);
            if (response.ok) state.writes++;
            return response;
          }
          const response = await originalFetch(...args);
          if (path.endsWith('/api/auth/sign-in/email') && response.ok) state.verified = true;
          if (path.endsWith('/v1/me') && response.ok) {
            const payload = await response.clone().json();
            payload.user.authProviders = ['email', 'google'];
            return new Response(JSON.stringify(payload), { status: response.status, headers: response.headers });
          }
          return response;
        };
      })()`);
    },
    async snapshot() {
      return seed.evalIn(web, `({ ...window.__skillRecovery, body: document.querySelector('textarea')?.value })`);
    },
    async duplicateSubmit() {
      await seed.evalIn(web, `document.querySelector('textarea').closest('form').requestSubmit()`);
    },
  };
}
