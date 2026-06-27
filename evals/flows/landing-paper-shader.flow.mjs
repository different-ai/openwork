const ROUTES_WITHOUT_SHADER = [
  { path: "/pricing", text: "OpenWork pricing" },
  { path: "/enterprise", text: "A privacy-first" },
  { path: "/trust", text: "Security & Data Privacy" },
  { path: "/privacy", text: "Privacy Policy" },
  { path: "/terms", text: "Terms of Service" },
  { path: "/og", text: "OpenWork" },
];

function routeUrl(ctx, path) {
  return new URL(path, ctx.env.OPENWORK_EVAL_LANDING_URL).toString();
}

async function navigateTo(ctx, path, text) {
  await ctx.eval(`location.href = ${JSON.stringify(routeUrl(ctx, path))}; true`);
  await ctx.waitFor(
    `location.pathname === ${JSON.stringify(path)} && document.body.innerText.includes(${JSON.stringify(text)})`,
    { timeoutMs: 30_000, label: `${path} route with ${text}` },
  );
}

async function shaderState(ctx) {
  return ctx.eval(`(() => ({
    path: location.pathname,
    hasLandingBackground: Boolean(document.querySelector(".landing-background-fade")),
    canvasCount: document.querySelectorAll("canvas").length,
  }))()`);
}

function recordShaderAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

export default {
  id: "landing-paper-shader",
  title: "Landing Paper shader is scoped to the root page",
  spec: "evals/README.md",
  requiredEnv: ["OPENWORK_EVAL_LANDING_URL"],
  steps: [
    {
      name: "Root route renders the Paper shader",
      run: async (ctx) => {
        await ctx.prove("The `/` landing page renders the Paper shader background", {
          action: async () => {
            await navigateTo(ctx, "/", "The open source");
            await ctx.waitFor(
              `Boolean(document.querySelector(".landing-background-fade canvas"))`,
              { timeoutMs: 30_000, label: "hydrated Paper shader canvas" },
            );
          },
          assert: async () => {
            const actual = await shaderState(ctx);
            recordShaderAssertion(
              ctx,
              "Root route has the landing background and a shader canvas",
              actual.hasLandingBackground === true && actual.canvasCount > 0,
              actual,
            );
          },
          screenshot: {
            name: "root-paper-shader",
            requireText: ["The open source"],
          },
        });
      },
    },
    {
      name: "Non-root routes do not render the Paper shader",
      run: async (ctx) => {
        for (const route of ROUTES_WITHOUT_SHADER) {
          await ctx.prove(`Route ${route.path} does not render the Paper shader`, {
            action: async () => {
              await navigateTo(ctx, route.path, route.text);
              await ctx.waitFor(
                `!document.querySelector(".landing-background-fade") && document.querySelectorAll("canvas").length === 0`,
                { timeoutMs: 30_000, label: `${route.path} without Paper shader` },
              );
            },
            assert: async () => {
              const actual = await shaderState(ctx);
              recordShaderAssertion(
                ctx,
                `${route.path} has no landing background and no shader canvas`,
                actual.hasLandingBackground === false && actual.canvasCount === 0,
                actual,
              );
            },
            screenshot: {
              name: `${route.path.slice(1) || "root"}-no-paper-shader`,
              requireText: [route.text],
            },
          });
        }
      },
    },
  ],
};
