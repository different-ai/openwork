import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { coworkPluginImport } from "../worlds/cowork-plugin-import.ts";

const test = spec.world(coworkPluginImport, { needs: { commands: ["bun"] }, timeout: 300_000 });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Listed = { name: string; dir: string | null; url: string; installable: boolean };

// The first thing a person migrating from Cowork pastes is the marketplace
// repository link. That failed with "Multiple plugins found (...)", listed
// only top-level folders (not partner-built/*), and gave no link to use.
test("a person who pastes a Cowork marketplace link learns which plugins it holds and how to install each", async ({ world, step, evidence }) => {
  let message = "";
  let plugins: Listed[] = [];

  await step("given the person pastes the marketplace repository link", async () => {
    const result = await world.api("POST", "/claude-plugins", { url: world.repoUrl(), dryRun: true });
    expect(result.status).toBe(400);
    message = record(result.body) && typeof result.body.message === "string" ? result.body.message : "";
    const details = record(result.body) && record(result.body.details) && Array.isArray(result.body.details.plugins) ? result.body.details.plugins : [];
    plugins = details.filter(record).map((item) => ({
      name: String(item.name),
      dir: typeof item.dir === "string" ? item.dir : null,
      url: String(item.url),
      installable: item.installable === true,
    }));
    evidence.recordAssertionEvidence("what the person reads", message, message.length > 0);
  });

  await step("then the message names every plugin, including nested partner plugins, and gives a link to paste", async () => {
    const installable = plugins.filter((plugin) => plugin.installable).map((plugin) => plugin.name);
    evidence.recordAssertionEvidence("installable plugins", installable.join(", "), installable.includes("Brand Voice"));
    expect(installable).toEqual(["Productivity", "Sales", "Brand Voice"]);
    expect(message).toContain("Brand Voice");
    expect(message).toContain(world.repoUrl("productivity"));
  });

  await step("and a plugin that lives in another repository is listed but not offered for install", async () => {
    const remote = plugins.find((plugin) => plugin.name === "remote-partner");
    evidence.recordAssertionEvidence("external plugin", remote ? `${remote.name} → ${remote.url} (installable: ${remote.installable})` : "missing", remote?.installable === false);
    expect(remote).toMatchObject({ installable: false, dir: null, url: "https://github.com/acme-partner/plugin.git" });
  });

  await step("after: each listed link previews exactly that plugin", async () => {
    const results: string[] = [];
    for (const plugin of plugins.filter((item) => item.installable)) {
      const result = await world.api("POST", "/claude-plugins", { url: plugin.url, dryRun: true });
      const name = record(result.body) && record(result.body.preview) ? String(result.body.preview.name) : `error ${result.status}`;
      results.push(`${plugin.dir} → ${name}`);
      expect(result.status).toBe(200);
    }
    evidence.recordAssertionEvidence("listed links work", results.join("; "), results.length === 3);
  });
});
