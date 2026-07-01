/**
 * A user can connect a custom OpenAI-compatible provider (Azure AI Foundry,
 * LiteLLM, vLLM, ...) entirely from the UI — Settings -> AI -> Connect
 * provider -> Add custom provider — without hand-editing opencode.jsonc or
 * pasting JSON into Cloud. The provider block is written to the workspace
 * config, the engine reloads, and the provider (with its models) comes back
 * from the engine as connected. Disconnect removes the block again.
 */
const PROVIDER_NAME = "Foundry Eval";
const PROVIDER_ID = "foundry-eval";
const BASE_URL = "https://eval-foundry.example.com/openai/v1";
const MODEL_ID = "eval-deployment-1";

export default {
  id: "custom-provider-add",
  title: "Add a custom OpenAI-compatible provider from the UI",
  spec: "packages/docs/start-here/connect-your-stack/add-a-custom-llm.mdx",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
      },
    },
    {
      name: "Open Settings -> AI",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/ai");
        await ctx.expectHashIncludes("/settings/ai");
        await ctx.expectText("Connect provider", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Connect providers modal offers a custom provider entry",
      run: async (ctx) => {
        await ctx.prove("The provider list has an 'Add custom provider' entry point", {
          action: async () => {
            await ctx.clickText("Connect provider", { timeoutMs: 30_000 });
            await ctx.expectText("Connect providers", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Add custom provider", { timeoutMs: 30_000 });
            await ctx.expectText("OpenAI-compatible endpoint");
          },
          screenshot: {
            name: "connect-modal-custom-entry",
            requireText: ["Connect providers", "Add custom provider"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Custom provider form captures endpoint details",
      run: async (ctx) => {
        await ctx.prove("The custom provider form collects name, ID, URL, key, and models", {
          action: async () => {
            await ctx.clickText("Add custom provider", { timeoutMs: 15_000 });
            await ctx.expectText("Custom provider", { timeoutMs: 15_000 });
            await ctx.fill('input[placeholder="Azure AI Foundry"]', PROVIDER_NAME);
            await ctx.fill('input[placeholder="azure-foundry"]', PROVIDER_ID);
            await ctx.fill('input[placeholder="https://my-resource.openai.azure.com/openai/v1"]', BASE_URL);
            await ctx.fill('input[placeholder="sk-..."]', "sk-eval-custom-123");
            await ctx.fill('input[placeholder="gpt-5.2, my-deployment-name"]', MODEL_ID);
          },
          assert: async () => {
            const nameValue = await ctx.eval(
              `document.querySelector('input[placeholder="Azure AI Foundry"]')?.value`,
            );
            ctx.assert(nameValue === PROVIDER_NAME, `Name field holds ${PROVIDER_NAME}`);
            const urlValue = await ctx.eval(
              `document.querySelector('input[placeholder="https://my-resource.openai.azure.com/openai/v1"]')?.value`,
            );
            ctx.assert(urlValue === BASE_URL, `Base URL field holds ${BASE_URL}`);
            await ctx.waitFor(
              `(() => {
                const buttons = [...document.querySelectorAll("button")];
                const add = buttons.find((el) => (el.textContent ?? "").trim() === "Add provider");
                return Boolean(add) && !add.disabled;
              })()`,
              { timeoutMs: 10_000, label: "Add provider button enabled" },
            );
          },
          screenshot: {
            name: "custom-provider-form-filled",
            requireText: ["Custom provider", "Base URL", "Model IDs"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Provider is installed and reported back by the engine",
      run: async (ctx) => {
        await ctx.prove("Submitting installs the provider and it appears as connected in Settings", {
          action: async () => {
            await ctx.clickText("Add provider", { timeoutMs: 15_000 });
            // The store writes opencode.jsonc, stores the key, reloads the
            // engine, and re-reads the provider list before the modal closes.
            await ctx.waitFor(
              `!document.body.innerText.includes("Connect providers") && !document.querySelector("[role=dialog]")`,
              { timeoutMs: 120_000, label: "connect modal fully dismissed after install" },
            );
          },
          assert: async () => {
            // The witness: the engine-reported provider list (rendered on the
            // AI settings page) now includes the new provider by name and ID.
            await ctx.expectText(PROVIDER_NAME, { timeoutMs: 60_000 });
            await ctx.expectText(PROVIDER_ID, { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "provider-connected",
            requireText: [PROVIDER_NAME, PROVIDER_ID],
            rejectText: ["Something went wrong", "Failed to add custom provider"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
    {
      name: "Disconnect removes the custom provider again",
      run: async (ctx) => {
        await ctx.prove("Disconnecting a custom provider removes its config block", {
          action: async () => {
            await ctx.waitFor(
              `(() => {
                const buttons = [...document.querySelectorAll("button")];
                const target = buttons.find((el) =>
                  (el.textContent ?? "").trim() === "Disconnect" &&
                  (el.parentElement?.textContent ?? "").includes(${JSON.stringify(PROVIDER_ID)}));
                if (!target) return false;
                target.click();
                return true;
              })()`,
              { timeoutMs: 30_000, label: "Disconnect button for the custom provider" },
            );
          },
          assert: async () => {
            await ctx.waitFor(
              `!document.body.innerText.includes(${JSON.stringify(PROVIDER_ID)})`,
              { timeoutMs: 120_000, label: "custom provider removed from the provider list" },
            );
          },
          screenshot: {
            name: "provider-removed",
            requireText: ["Connect provider"],
            rejectText: [PROVIDER_ID, "Something went wrong"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
  ],
};
