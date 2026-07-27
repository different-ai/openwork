import { defineFlow } from "../runner/flow.ts";

type HandoffCreateResponse = {
  grant?: string;
  openworkUrl?: string;
};

type HandoffStatusResponse = {
  status?: string;
  consumed?: boolean;
};

const state: {
  grant: string;
  openworkUrl: string;
} = {
  grant: "",
  openworkUrl: "",
};

function cleanBaseUrl(value: string | undefined) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

async function readJson(response: Response) {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { text, body };
}

export default defineFlow({
  id: "enterprise-desktop-activation",
  title: "Enterprise desktop stays locked until a one-time Den activation",
  kind: "user-facing",
  spec: "evals/enterprise-desktop-activation.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Fresh enterprise app is locked",
      run: async (ctx) => {
        await ctx.waitForText("Activate this app from your Den portal.", {
          timeoutMs: 30_000,
        });
        const distribution = await ctx.eval(
          "window.__OPENWORK_ELECTRON__?.meta?.distribution ?? null",
        ) as { flavor?: string; requireSignin?: boolean } | null;
        ctx.assert(distribution?.flavor === "enterprise", "The running app is not the enterprise distribution.");
        ctx.assert(distribution?.requireSignin === true, "Enterprise distribution does not require sign-in.");
        await ctx.expectNoText("Use without cloud");
        await ctx.screenshot("enterprise-activation-required", {
          claim: "A fresh enterprise installation shows only the Den activation gate.",
          requireText: [
            "OpenWork Enterprise",
            "Activate this app from your Den portal.",
            "Sign-in stays required",
            "Waiting for an activation link from Den",
          ],
          rejectText: ["Use without cloud"],
          pretty: true,
        });
      },
    },
    {
      name: "Runtime commands are unavailable before activation",
      run: async (ctx) => {
        const result = await ctx.eval(`(async () => {
          try {
            await window.__OPENWORK_ELECTRON__.invokeDesktop("engineInfo");
            return { rejected: false, message: "" };
          } catch (error) {
            return {
              rejected: true,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        })()`, { awaitPromise: true }) as { rejected?: boolean; message?: string };
        ctx.assert(result.rejected === true, "The enterprise app accepted a runtime command before activation.");
        ctx.assert(
          result.message?.includes("must be activated from your Den portal"),
          `Unexpected pre-activation rejection: ${result.message ?? ""}`,
        );
      },
    },
    {
      name: "Den issues a one-time enterprise handoff",
      run: async (ctx) => {
        const denApiUrl = cleanBaseUrl(ctx.env.OPENWORK_EVAL_DEN_API_URL);
        const response = await fetch(`${denApiUrl}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        const payload = await readJson(response);
        ctx.assert(response.ok, `Handoff create failed: ${response.status} ${payload.text.slice(0, 300)}`);
        const body = payload.body as HandoffCreateResponse;
        const openworkUrl = typeof body.openworkUrl === "string" ? body.openworkUrl : "";
        ctx.assert(openworkUrl.length > 0, "Den returned no enterprise deep link.");
        ctx.assert(openworkUrl.startsWith("openwork:"), "Den returned the wrong desktop scheme.");
        const parsed = new URL(openworkUrl);
        state.grant = body.grant ?? parsed.searchParams.get("grant") ?? "";
        state.openworkUrl = openworkUrl;
        ctx.assert(state.grant.length > 0, "Den returned no one-time handoff grant.");
      },
    },
    {
      name: "Opening the deep link activates and signs in the app",
      run: async (ctx) => {
        await ctx.eval(`(() => {
          window.dispatchEvent(new CustomEvent("openwork:deep-link-native", {
            detail: [${JSON.stringify(state.openworkUrl)}],
          }));
          return true;
        })()`);
        await ctx.waitFor(
          "!document.body.innerText.includes('Activate this app from your Den portal.')",
          { timeoutMs: 45_000, label: "enterprise activation gate dismissed" },
        );
        const bootstrap = await ctx.eval(
          "window.__OPENWORK_ELECTRON__.invokeDesktop('getDesktopBootstrapConfig')",
          { awaitPromise: true },
        ) as {
          baseUrl?: string;
          requireSignin?: boolean;
          enterpriseActivation?: { activatedAt?: string; denBaseUrl?: string } | null;
        };
        const denApiUrl = cleanBaseUrl(ctx.env.OPENWORK_EVAL_DEN_API_URL);
        ctx.assert(bootstrap.requireSignin === true, "Activation did not preserve required sign-in.");
        ctx.assert(Boolean(bootstrap.enterpriseActivation?.activatedAt), "Activation timestamp was not persisted.");
        ctx.assert(
          cleanBaseUrl(bootstrap.enterpriseActivation?.denBaseUrl) === denApiUrl,
          `Activation persisted the wrong Den URL: ${bootstrap.enterpriseActivation?.denBaseUrl ?? ""}`,
        );
        await ctx.screenshot("enterprise-activated", {
          claim: "The one-time Den link removes the activation gate and unlocks the signed-in enterprise app.",
          rejectText: [
            "Activate this app from your Den portal.",
            "Use without cloud",
          ],
          pretty: true,
        });
      },
    },
    {
      name: "Den records the activation grant as consumed",
      run: async (ctx) => {
        const denApiUrl = cleanBaseUrl(ctx.env.OPENWORK_EVAL_DEN_API_URL);
        const response = await fetch(`${denApiUrl}/v1/auth/desktop-handoff/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: state.grant }),
        });
        const payload = await readJson(response);
        ctx.assert(response.ok, `Handoff status failed: ${response.status} ${payload.text.slice(0, 300)}`);
        const body = payload.body as HandoffStatusResponse;
        ctx.assert(
          body.consumed === true || body.status === "consumed",
          `Expected consumed handoff, got ${payload.text.slice(0, 300)}`,
        );
      },
    },
  ],
});
