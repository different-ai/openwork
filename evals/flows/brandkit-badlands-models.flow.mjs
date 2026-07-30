const EXPECTED_MODELS = [
  ["@preset/auto", "Auto"],
  ["claude-sonnet-5", "Anthropic Sonnet 5"],
  ["minimax-m3", "MiniMax M3"],
];

async function requiresClinicWork(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  const title = await ctx.eval("document.title");
  return title === "ClinicWork"
    ? null
    : "Apply the ClinicWork brand before running this flow.";
}

export default {
  id: "brandkit-badlands-models",
  title: "ClinicWork exposes only the three curated Badlands models",
  kind: "user-facing",
  precondition: requiresClinicWork,
  steps: [
    {
      name: "Curated Badlands model picker",
      run: async (ctx) => {
        await ctx.prove("The model picker contains exactly the three branded Badlands choices", {
          voiceover: "The ClinicWork model picker defaults to Auto and offers only Anthropic Sonnet 5 and MiniMax M3 alongside it.",
          action: async () => {
            await ctx.eval(`(() => {
              for (let index = 0; index < 3; index += 1) {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              }
              return true;
            })()`);
            await ctx.control("session.model_picker.open");
          },
          assert: async () => {
            const result = await ctx.waitFor(
              `(() => {
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return null;
                const text = dialog.innerText;
                const expected = ${JSON.stringify(EXPECTED_MODELS)};
                return {
                  header: text.includes("Badlands Labs 3 models"),
                  models: expected.map(([id, name]) => ({
                    id,
                    name,
                    present: text.includes(id) && text.includes(name),
                  })),
                };
              })()`,
              { timeoutMs: 30_000, label: "Badlands model picker" },
            );
            ctx.assert(result?.header, "Picker did not report exactly 3 Badlands models.");
            ctx.assert(
              result.models.every((model) => model.present),
              `Missing curated model: ${JSON.stringify(result.models)}`,
            );
          },
          screenshot: {
            name: "badlands-three-models",
            claim: "The picker reports three Badlands models and shows only Auto, Anthropic Sonnet 5, and MiniMax M3.",
            requireText: [
              "Badlands Labs 3 models",
              "Auto",
              "@preset/auto",
              "Anthropic Sonnet 5",
              "claude-sonnet-5",
              "MiniMax M3",
              "minimax-m3",
            ],
            rejectText: ["Something went wrong", "Unauthorized"],
          },
        });
      },
    },
  ],
};
