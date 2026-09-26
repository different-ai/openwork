import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET as installScript } from "../app/install.sh/route";
import { downloadPlatformHref, downloadPlatforms, isDownloadPlatform } from "../lib/download-platforms";
import { agentMarkdown } from "../lib/agent-markdown";
import { config, middleware } from "../middleware";

const publicDir = join(import.meta.dir, "../public");
const wellKnown = join(publicDir, ".well-known");
const llms = readFileSync(join(publicDir, "llms.txt"), "utf8");
const docsDir = join(import.meta.dir, "../../../../packages/docs");

const MCP_URL = "https://api.openworklabs.com/mcp/agent";
const SIGN_UP_URL = "https://app.openworklabs.com?mode=sign-up";
const CLAUDE_ADD = `claude mcp add --transport http openwork ${MCP_URL}`;
const CODEX_ADD = `codex mcp add openwork --url ${MCP_URL}`;
const GEMINI_ADD = `gemini mcp add --transport http openwork ${MCP_URL}`;
const BREW = "brew install --cask openwork";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

describe("llms.txt agent block", () => {
  const agentBlock = llms.slice(llms.indexOf("## For agents: do this"), llms.indexOf("## What OpenWork does"));

  test("appears before the marketing sections", () => {
    expect(llms.indexOf("## For agents: do this")).toBeGreaterThan(0);
    expect(llms.indexOf("## For agents: do this")).toBeLessThan(llms.indexOf("## What OpenWork does"));
  });

  test("routes the three user intents", () => {
    expect(agentBlock).toContain('"Just me"');
    expect(agentBlock).toContain('"My team"');
    expect(agentBlock).toContain('"Inside my agent"');
  });

  test("has the exact install, signup, and MCP commands", () => {
    for (const needle of [BREW, SIGN_UP_URL, CLAUDE_ADD, CODEX_ADD, GEMINI_ADD, "codex mcp login openwork", "https://api.openworklabs.com/openapi.json", "https://openworklabs.com/install.sh", "https://openworklabs.com/start.md"]) {
      expect(agentBlock).toContain(needle);
    }
    for (const slug of Object.keys(downloadPlatforms)) {
      expect(agentBlock).toContain(`https://openworklabs.com/download/${slug}`);
    }
  });

  test("disambiguates the unrelated npm package and never recommends it", () => {
    expect(agentBlock).toContain("the npm package named `openwork` is a different project");
    for (const line of llms.split("\n")) {
      if (line.includes("npx openwork") || line.includes("npm install openwork")) {
        expect(line).toMatch(/do not|don't|never/i);
      }
    }
  });

  test("links every published agent skill and the MCP discovery files", () => {
    for (const name of ["install-openwork", "connect-openwork-mcp", "set-up-openwork-team", "workspace-guide"]) {
      expect(llms).toContain(`https://openworklabs.com/.well-known/agent-skills/${name}/SKILL.md`);
    }
    expect(llms).toContain("https://openworklabs.com/.well-known/mcp/server-card.json");
    expect(llms).toContain("https://openworklabs.com/.well-known/mcp.json");
  });

  test("links docs pages that exist in packages/docs", () => {
    const docsLinks = [...llms.matchAll(/https:\/\/openworklabs\.com\/docs\/([a-z0-9/.-]+)/g)].map((m) => m[1]);
    expect(docsLinks.length).toBeGreaterThan(5);
    for (const slug of docsLinks) {
      expect(`${slug}: ${existsSync(join(docsDir, `${slug}.mdx`))}`).toBe(`${slug}: true`);
    }
  });
});

describe("agent skills index", () => {
  const index = readJson(join(wellKnown, "agent-skills/index.json"));
  const skills = field(index, "skills");

  test("uses the agentskills v0.2.0 schema", () => {
    expect(field(index, "$schema")).toBe("https://agentskills.io/schemas/v0.2.0/index.json");
    expect(Array.isArray(skills)).toBe(true);
  });

  test("lists the setup skills and keeps workspace-guide", () => {
    const names = Array.isArray(skills) ? skills.map((skill) => field(skill, "name")) : [];
    expect(names).toEqual(["install-openwork", "connect-openwork-mcp", "set-up-openwork-team", "workspace-guide"]);
  });

  test("each entry's sha256, url, and description match its SKILL.md", () => {
    for (const skill of Array.isArray(skills) ? skills : []) {
      const name = String(field(skill, "name"));
      const body = readFileSync(join(wellKnown, "agent-skills", name, "SKILL.md"));
      expect(field(skill, "type")).toBe("skill");
      expect(field(skill, "url")).toBe(`https://openworklabs.com/.well-known/agent-skills/${name}/SKILL.md`);
      expect(field(skill, "sha256")).toBe(createHash("sha256").update(body).digest("hex"));
      const text = body.toString("utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: `));
      expect(text).toContain(`description: ${String(field(skill, "description"))}\n`);
    }
  });

  test("setup skills carry the exact commands", () => {
    const read = (name: string) => readFileSync(join(wellKnown, "agent-skills", name, "SKILL.md"), "utf8");
    expect(read("install-openwork")).toContain(BREW);
    expect(read("install-openwork")).toContain("https://openworklabs.com/download/linux-x64");
    expect(read("connect-openwork-mcp")).toContain(CLAUDE_ADD);
    expect(read("connect-openwork-mcp")).toContain(CODEX_ADD);
    expect(read("connect-openwork-mcp")).toContain(GEMINI_ADD);
    expect(read("connect-openwork-mcp")).toContain("search_capabilities");
    expect(read("set-up-openwork-team")).toContain(SIGN_UP_URL);
    expect(read("set-up-openwork-team")).toContain("https://openworklabs.com/start.md");
  });
});

describe("MCP discovery", () => {
  const card = readJson(join(wellKnown, "mcp/server-card.json"));
  const discovery = readJson(join(wellKnown, "mcp.json"));
  const registry = readJson(join(import.meta.dir, "../../../apps/den-api/server.json"));

  test("server card describes the gateway", () => {
    expect(field(card, "name")).toBe("com.openworklabs/openwork");
    expect(typeof field(card, "description")).toBe("string");
    expect(field(card, "url")).toBe(MCP_URL);
    expect(field(card, "transport")).toBe("streamable-http");
    expect(field(card, "authentication")).toBe("oauth2");
    expect(field(field(card, "auth"), "protectedResourceMetadata")).toBe("https://api.openworklabs.com/.well-known/oauth-protected-resource/mcp/agent");
    expect(field(field(card, "install"), "claude-code")).toBe(CLAUDE_ADD);
  });

  test("/.well-known/mcp.json points at the same server", () => {
    expect(field(discovery, "url")).toBe(MCP_URL);
    expect(field(discovery, "transport")).toBe("streamable-http");
    const servers = field(discovery, "servers");
    expect(Array.isArray(servers) && servers.length === 1 && field(servers[0], "url") === MCP_URL).toBe(true);
    expect(field(discovery, "serverCard")).toBe("https://openworklabs.com/.well-known/mcp/server-card.json");
  });

  test("registry server.json matches the card and registry limits", () => {
    expect(field(registry, "name")).toBe(field(card, "name"));
    const description = String(field(registry, "description"));
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(100);
    expect(field(registry, "remotes")).toEqual([{ type: "streamable-http", url: MCP_URL }]);
  });
});

describe("stable download URLs", () => {
  const installers = {
    macos: { appleSilicon: "https://x/mac-arm64.dmg", intel: "https://x/mac-x64.dmg" },
    windows: { x64: "https://x/win-x64.exe", arm64: "https://x/win-arm64.exe" },
    linux: { appImageX64: "https://x/linux-x64.AppImage", appImageArm64: "https://x/linux-arm64.AppImage", tarX64: "https://x/linux-x64.tar.gz", tarArm64: "https://x/linux-arm64.tar.gz" },
  };

  test("each slug resolves to its installer", () => {
    expect(isDownloadPlatform("mac-arm64")).toBe(true);
    expect(isDownloadPlatform("toString")).toBe(false);
    expect(downloadPlatformHref(installers, "mac-arm64")).toBe(installers.macos.appleSilicon);
    expect(downloadPlatformHref(installers, "mac-x64")).toBe(installers.macos.intel);
    expect(downloadPlatformHref(installers, "win-x64")).toBe(installers.windows.x64);
    expect(downloadPlatformHref(installers, "win-arm64")).toBe(installers.windows.arm64);
    expect(downloadPlatformHref(installers, "linux-x64")).toBe(installers.linux.appImageX64);
    expect(downloadPlatformHref(installers, "linux-arm64")).toBe(installers.linux.appImageArm64);
  });
});

describe("markdown negotiation", () => {
  function request(path: string) {
    return new NextRequest(`https://openworklabs.com${path}`, { headers: { accept: "text/markdown" } });
  }

  test("every agentMarkdown route is covered by the middleware matcher", () => {
    expect([...config.matcher].sort()).toEqual(Object.keys(agentMarkdown).sort());
  });

  test("/download returns markdown with the exact install URLs", async () => {
    const response = middleware(request("/download"));
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body).toContain(BREW);
    expect(body).toContain("No account required");
    expect(body).toContain(SIGN_UP_URL);
    for (const slug of Object.keys(downloadPlatforms)) {
      expect(body).toContain(`https://openworklabs.com/download/${slug}`);
    }
  });

  test("/connect and /cloud return markdown with the signup URL", async () => {
    for (const path of ["/connect", "/cloud"]) {
      const response = middleware(request(path));
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await response.text()).toContain(SIGN_UP_URL);
    }
    expect(await middleware(request("/connect")).text()).toContain(CLAUDE_ADD);
  });

  test("browsers still get HTML", () => {
    const response = middleware(new NextRequest("https://openworklabs.com/download", { headers: { accept: "text/html,*/*;q=0.8" } }));
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept");
  });
});

describe("install.sh", () => {
  test("says it installs the bootstrap CLI, not the desktop app, and how to get the app", async () => {
    const script = await installScript().text();
    expect(script.startsWith("#!/usr/bin/env sh\n")).toBe(true);
    expect(script).toContain("This does NOT install the OpenWork desktop app.");
    expect(script).toContain(BREW);
    expect(script).toContain("https://openworklabs.com/download");
    expect(script).toContain("https://openworklabs.com/start.md");
  });

  test("is valid POSIX sh", async () => {
    const script = await installScript().text();
    const result = Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) });
    expect(result.exitCode).toBe(0);
  });
});
