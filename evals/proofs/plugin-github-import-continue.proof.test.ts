import { createServer } from "node:http";
import { expect } from "vitest";
import type { Seed } from "@openwork/env";
import { spec } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

const OWNER = "example-org";
const REPO = "example-plugins";
const HEAD_SHA = "1111111111111111111111111111111111111111";
const TREE_SHA = "2222222222222222222222222222222222222222";
const FILES: Record<string, string> = {
  "legal/.claude-plugin/plugin.json": JSON.stringify({ name: "legal", description: "Contract review helpers", version: "1.0.0" }),
  "legal/skills/review-contract/SKILL.md": "---\nname: review-contract\ndescription: Review a contract for risky clauses\n---\n\nRead the contract and list risky clauses.\n",
  "legal/skills/triage-nda/SKILL.md": "---\nname: triage-nda\ndescription: Triage an incoming NDA\n---\n\nCheck the NDA term and governing law.\n",
};

/** A fixed public GitHub repository, served locally through Den's public-GitHub overrides. */
async function pluginGithubImport(seed: Seed) {
  const github = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const repoPath = `/api/repos/${OWNER}/${REPO}`;
    if (url.pathname === repoPath) { json({ default_branch: "main", private: false }); return; }
    if (url.pathname === `${repoPath}/commits/main`) { json({ sha: HEAD_SHA, commit: { tree: { sha: TREE_SHA } } }); return; }
    if (url.pathname === `${repoPath}/git/trees/${TREE_SHA}`) {
      const dirs = new Set<string>();
      for (const path of Object.keys(FILES)) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
      }
      json({
        truncated: false,
        tree: [
          ...[...dirs].map((path) => ({ path, type: "tree", sha: null })),
          ...Object.entries(FILES).map(([path, text], index) => ({ path, type: "blob", sha: `blob${index}`, size: text.length })),
        ],
      });
      return;
    }
    const rawPrefix = `/raw/${OWNER}/${REPO}/${HEAD_SHA}/`;
    if (url.pathname.startsWith(rawPrefix)) {
      const text = FILES[decodeURIComponent(url.pathname.slice(rawPrefix.length))];
      if (text !== undefined) { res.writeHead(200, { "content-type": "text/plain" }); res.end(text); return; }
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
  });
  await new Promise<void>(resolve => github.listen(0, "127.0.0.1", resolve));
  const close = async () => { github.closeAllConnections(); await new Promise<void>(resolve => github.close(() => resolve())); };
  try {
    const address = github.address(); if (!address || typeof address === "string") throw new Error("GitHub fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const den = await seed.den({
      env: { DEN_PUBLIC_GITHUB_API_BASE: `${origin}/api`, DEN_PUBLIC_GITHUB_RAW_BASE: `${origin}/raw` },
      org: { name: "exp-plugin-import-org" },
    });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/plugins/new", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den, web,
      githubUrl: `https://github.com/${OWNER}/${REPO}/tree/main/legal`,
      async importedPlugin() {
        const result = await seed.api(den.admin, "/v1/plugins");
        const items = isRecord(result.body) && Array.isArray(result.body.items) ? result.body.items.filter(isRecord) : [];
        return items.find(item => item.name === "Legal") ?? null;
      },
      async [Symbol.asyncDispose]() { await close(); },
    };
  } catch (error) { await close(); throw error; }
}

const test = spec.world(pluginGithubImport, { timeout: 600_000, needs: { commands: ["bun", "pnpm"], placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

test("an admin imports a plugin from GitHub starting at Create a plugin, and the import reaches the create form", async ({ world, user, probe, step, evidence }) => {
  await step("Create a plugin offers Import from GitHub", async () => {
    await user.see({ text: "Create a plugin" }, { timeoutMs: 90_000 });
    await user.see({ role: "link", label: "Import from GitHub" });
    await user.screenshot();
    await user.click({ role: "link", label: "Import from GitHub" });
    await user.see({ text: "GitHub plugin URL" }, { timeoutMs: 30_000 });
  });

  await step("the admin previews the repository and continues", async () => {
    await user.type({ placeholder: "https://github.com/anthropics/knowledge-work-plugins/tree/main/sales" }, world.githubUrl, { replace: true });
    await user.click({ role: "button", label: "Preview" });
    await user.see({ text: "review-contract" }, { timeoutMs: 60_000 });
    await user.see({ text: "triage-nda" });
    await user.screenshot();
    await user.click({ role: "button", label: "Continue to create" });
  });

  await step("after: the create form shows the imported skills", async () => {
    await user.see({ text: "Imported from GitHub" }, { timeoutMs: 30_000 });
    await user.see({ text: "review-contract" });
    await user.see({ text: "triage-nda" });
    const url = await probe.url();
    evidence.recordAssertionEvidence("Continue to create opens the form that reads the import", `url=${url}`, url.includes("source=github-import"));
    await user.screenshot();
  });

  await step("Create plugin creates it with both imported skills", async () => {
    await user.type({ placeholder: "e.g. Sales call prep" }, "Legal", { replace: true });
    await user.click({ role: "button", label: "Create plugin" });
    await user.notSee({ text: "Add a skill, a command or a connector." }, { timeoutMs: 5_000 });
    const plugin = await probe.eventually(() => world.importedPlugin(), { within: 30_000, label: "imported plugin exists", until: value => value !== null });
    evidence.recordAssertionEvidence("The imported plugin exists", `plugin=${JSON.stringify(plugin)}`, plugin !== null);
    expect(plugin).not.toBeNull();
    await user.see({ text: "Review contract" }, { timeoutMs: 30_000 });
    await user.see({ text: "Triage nda" });
    await user.screenshot();
  });
});
