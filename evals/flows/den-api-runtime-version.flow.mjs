import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-api-runtime-version";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: JSON.stringify(actual),
  });
  ctx.assert(condition, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

export default {
  id: FLOW_ID,
  title: "Den reports the running API version from its public health endpoint",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_API_VERSION"],
  steps: [
    {
      name: "The public health response identifies the running Den build",
      run: async (ctx) => {
        const baseUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const expectedVersion = ctx.env.OPENWORK_EVAL_DEN_API_VERSION.trim();

        await ctx.prove("An operator can see the exact Den API version serving traffic", {
          voiceover: vo[0],
          action: async () => {
            await ctx.client.send("Page.navigate", { url: `${baseUrl}/health` });
            await ctx.waitFor("document.readyState === 'complete'", {
              timeoutMs: 20_000,
              label: "Den health response",
            });
          },
          assert: async () => {
            const payload = await ctx.eval("JSON.parse(document.body.innerText)");
            witness(ctx, payload.ok === true, "The health response is healthy", payload);
            witness(ctx, payload.service === "den-api", "The response identifies den-api", payload);
            witness(ctx, payload.version === expectedVersion, "The response reports the expected running version", payload);
          },
          screenshot: {
            name: "den-api-runtime-version",
            requireText: ["den-api", expectedVersion],
          },
        });
      },
    },
  ],
};
