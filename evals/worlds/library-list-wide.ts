import type { Seed } from "@openwork/env";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enableOrganizationCapabilities } from "./dashboards.ts";

/** Skills a member wrote in this workspace: enough rows to read lanes across. */
export const librarySkills = [
  { name: "weekly-update", description: "Drafts the Friday team update from this week's sessions, merged work and calendar." },
  { name: "brand-voice", description: "Tone, words we use and words we avoid in anything customer-facing." },
  { name: "invoice-cleanup", description: "Renames and sorts vendor invoices in a folder by vendor and month." },
  { name: "release-notes", description: "Turns merged pull requests into short customer-facing release notes." },
  { name: "research-brief", description: "Web research with source notes and a cited one-page summary." },
] as const;

/** MCP servers written by hand into opencode.json; off, so no process starts. */
const handWrittenServers = {
  "docs-helper": { type: "local", command: ["python3", "-m", "http.server", "8321"], enabled: false },
  "files-helper": { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"], enabled: false },
  "tickets-helper": { type: "remote", url: "https://mcp.example.test/sse", enabled: false },
};

/**
 * One member's workspace with a handful of skills and MCP servers, opened in
 * the real app in headless Chrome. The signed-out case reads the real public
 * deployment flags; the signed-in case adds an organization-only override.
 */
async function buildLibraryListWide(seed: Seed, integrated: boolean) {
  const workspacePath = seed.tmpPath("library-list-wide");
  for (const skill of librarySkills) {
    const directory = join(workspacePath, ".opencode", "skills", skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nFollow the description.\n`);
  }
  await writeFile(
    join(workspacePath, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: handWrittenServers }, null, 2)}\n`,
  );
  const den = await seed.den({ org: { name: "Integrated Library", admin: { name: "Library Owner" } } });
  if (integrated) await enableOrganizationCapabilities(seed, den.admin, { libraryIntegrated: true });
  const app = await seed.appWeb({ name: "library-list-wide", workspacePath,
    env: {
      // Use the existing app-web Den proxy, as the MCP App journeys do. Browser
      // auth and feature reads must not depend on cross-origin loopback access.
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1",
      OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl,
      VITE_DEN_API_BASE_URL: "/api/den",
      // The isolated runtime does not inherit executable overrides. Local proof can pin v1
      // when the machine's default opencode is v2; CI keeps its normal provisioned binary.
      ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
    },
  });
  if (integrated) await seed.signIn(app, den.admin, "Library Owner");
  return { app, den, workspacePath, skills: librarySkills.map((skill) => skill.name), servers: Object.keys(handWrittenServers) };
}

export const libraryListWide = (seed: Seed) => buildLibraryListWide(seed, false);
export const integratedLibraryListWide = (seed: Seed) => buildLibraryListWide(seed, true);
