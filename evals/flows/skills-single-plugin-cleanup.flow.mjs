/**
 * User-facing flow demo: the skill-hub concept is gone. Workspace skills stay
 * first-class in the Extensions view (Skills filter), and shared team
 * extensions — including skills published by an organization — live in the
 * Extension Marketplace (plugins), not in a separate skill hub catalog.
 *
 * Requires an installed workspace skill so the Skills filter has content.
 * Seed one before running, e.g.
 *   mkdir -p <workspace>/.opencode/skills/release-notes-draft && write SKILL.md
 */

const SKILL_TITLE = "release-notes-draft";

export default {
  id: "skills-single-plugin-cleanup",
  title: "Skills without hubs: local skills + marketplace-backed sharing",
  kind: "user-facing",
  steps: [
    {
      name: "App boots and the control API is ready",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl",
        });
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          label: "rendered body text",
        });
      },
    },
    {
      name: "Extensions view lists workspace skills without any hub catalog",
      run: async (ctx) => {
        await ctx.prove("Skills stay first-class in Extensions; the hub catalog is gone", {
          claim: "The Extensions settings view filters to Skills and lists the installed workspace skill; no GitHub skill-hub catalog or custom hub repositories exist anywhere.",
          voiceover:
            "I open Settings and go to Extensions. My workspace skills are right here — I can filter to Skills and see the skill I installed, with no separate hub catalog to browse or manage.",
          action: async () => {
            await ctx.control("settings.panel.open", { panel: "extensions" });
            await ctx.waitForText(SKILL_TITLE, { timeoutMs: 30_000 });
            await ctx.clickText("Skills");
            await ctx.waitForText(SKILL_TITLE, { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText(SKILL_TITLE);
            await ctx.expectNoText("GitHub-backed hubs");
            await ctx.expectNoText("openwork-hub");
            await ctx.expectNoText("Skill hub");
            const filters = await ctx.eval(`(() => {
              const labels = Array.from(document.querySelectorAll("button"))
                .map((el) => el.textContent.trim());
              return {
                hasSkillsFilter: labels.includes("Skills"),
                hasHubFilter: labels.includes("Hub"),
              };
            })()`);
            ctx.assert(filters.hasSkillsFilter, "Skills filter chip is present");
            ctx.assert(!filters.hasHubFilter, "No Hub filter chip exists");
          },
          screenshot: {
            name: "extensions-skills-no-hub",
            requireText: ["Skills", SKILL_TITLE],
            rejectText: ["GitHub-backed hubs", "openwork-hub", "Skill hub"],
          },
        });
      },
    },
    {
      name: "Shared team extensions live in the Extension Marketplace",
      run: async (ctx) => {
        await ctx.prove("The marketplace panel is the single home for shared skills", {
          claim: "The cloud-marketplaces settings panel renders the Extension Marketplace, where organization-published plugins (including single-skill plugins) are discovered.",
          voiceover:
            "Everything a team shares — including skills your organization publishes — now lives in one place: the Extension Marketplace, powered by plugins.",
          action: async () => {
            await ctx.control("settings.panel.open", { panel: "cloud-marketplaces" });
            await ctx.waitForText("Extension Marketplace", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectText("Extension Marketplace");
            await ctx.expectNoText("Skill hub");
          },
          screenshot: {
            name: "extension-marketplace-panel",
            requireText: ["Extension Marketplace"],
            rejectText: ["Skill hub"],
          },
        });
      },
    },
  ],
};
