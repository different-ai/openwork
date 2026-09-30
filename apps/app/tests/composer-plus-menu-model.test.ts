import { describe, expect, test } from "bun:test";

import type { SkillCard } from "../src/app/types";
import {
  buildPlusMenuModel,
  humanizeCapabilityName,
  plusMenuParentView,
  type PlusMenuConnector,
  type PlusMenuInput,
  type PlusMenuItem,
} from "../src/react-app/domains/session/surface/composer/composer-plus-menu-model";
import { composerConnectorLogoUrls } from "../src/react-app/domains/session/surface/composer/composer-connector-logos";

function connector(name: string, signIn = false): PlusMenuConnector {
  return {
    key: name.toLowerCase(),
    name,
    serviceUrl: "http://127.0.0.1:4000/mcp",
    signIn: signIn ? { connectionId: `conn-${name}`, reconnect: false } : null,
    connecting: false,
    note: null,
  };
}

const skills: SkillCard[] = [
  { name: "customer-briefing", path: "/skills/customer-briefing/SKILL.md", description: "Brief an account" },
  { name: "HubSpot deal summary", path: "/skills/hubspot-deal/SKILL.md" },
];

function input(overrides: Partial<PlusMenuInput> = {}): PlusMenuInput {
  return {
    view: { kind: "root" },
    query: "",
    skills,
    connectors: [connector("HubSpot"), connector("GitHub"), connector("Slack", true)],
    plugins: [],
    agents: [{ name: null, label: "Default agent", selected: true }],
    commands: [{ id: "review", name: "review", source: "command" }],
    files: ["reports/hubspot-export.csv"],
    recentIds: [],
    ...overrides,
  };
}

function labels(items: PlusMenuItem[]): string[] {
  return items.map((item) => (item.kind === "section" ? `section:${item.section}` : item.kind === "attach" ? "attach" : item.label));
}

describe("buildPlusMenuModel", () => {
  test("empty root shows attach first, then browse sections with counts", () => {
    const model = buildPlusMenuModel(input());
    expect(model.groups.map((group) => group.id)).toEqual(["attach", "browse"]);
    const browse = model.groups[1]?.items ?? [];
    expect(labels(browse)).toEqual(["section:skills", "section:connectors", "section:plugins", "section:agents-commands"]);
    const connectors = browse[1];
    expect(connectors?.kind === "section" ? connectors.count : -1).toBe(3);
  });

  test("recent picks show only when the item still exists", () => {
    const model = buildPlusMenuModel(input({ recentIds: ["connector:slack", "connector:gone", "command:review"] }));
    expect(model.groups.map((group) => group.id)).toEqual(["attach", "recent", "browse"]);
    expect(labels(model.groups[1]?.items ?? [])).toEqual(["Slack", "review"]);
  });

  test("a query groups results by section, strongest section first, files last", () => {
    const model = buildPlusMenuModel(input({ query: "hub" }));
    expect(model.groups.map((group) => group.id)).toEqual(["connectors", "skills", "files"]);
    expect(labels(model.groups[0]?.items ?? [])).toEqual(["HubSpot", "GitHub"]);
    expect(labels(model.groups[2]?.items ?? [])).toEqual(["hubspot-export.csv", "attach"]);
  });

  test("typo-tolerant queries find skills by their readable name", () => {
    const model = buildPlusMenuModel(input({ query: "cust brf" }));
    const skillsGroup = model.groups.find((group) => group.id === "skills");
    expect(labels(skillsGroup?.items ?? [])).toEqual(["Customer briefing"]);
  });

  test("no matches falls back to the browse list", () => {
    const model = buildPlusMenuModel(input({ query: "zqx" }));
    expect(model.noMatches).toBe(true);
    expect(model.groups.map((group) => group.id)).toEqual(["browse"]);
  });

  test("a section lists its items and a manage row", () => {
    const model = buildPlusMenuModel(input({ view: { kind: "section", section: "skills" } }));
    expect(model.groups.map((group) => group.id)).toEqual(["skills", "manage"]);
    expect(labels(model.groups[0]?.items ?? [])).toEqual(["Customer briefing", "HubSpot deal summary"]);
  });

  test("searching inside a section only searches that section", () => {
    const model = buildPlusMenuModel(input({ view: { kind: "section", section: "connectors" }, query: "hub" }));
    expect(model.groups.map((group) => group.id)).toEqual(["connectors", "manage"]);
  });

  test("agents and commands share one section", () => {
    const model = buildPlusMenuModel(input({ view: { kind: "section", section: "agents-commands" } }));
    expect(model.groups.map((group) => group.id)).toEqual(["agents", "commands", "manage"]);
  });

  test("back goes from a plugin to plugins to the root", () => {
    expect(plusMenuParentView({ kind: "plugin", pluginId: "p1" })).toEqual({ kind: "section", section: "plugins" });
    expect(plusMenuParentView({ kind: "section", section: "plugins" })).toEqual({ kind: "root" });
    expect(plusMenuParentView({ kind: "root" })).toBeNull();
  });
});

describe("humanizeCapabilityName", () => {
  test("turns slugs into sentence case and keeps names that already have capitals", () => {
    expect(humanizeCapabilityName("customer-briefing")).toBe("Customer briefing");
    expect(humanizeCapabilityName("HubSpot deal summary")).toBe("HubSpot deal summary");
  });
});

describe("composerConnectorLogoUrls", () => {
  test("uses a bundled logo for known services", () => {
    expect(composerConnectorLogoUrls({ name: "HubSpot", serviceUrl: "http://127.0.0.1:4000/mcp" })).toEqual(["/ext-hubspot.svg"]);
  });

  test("falls back to the apex-domain favicon for public servers", () => {
    const [url] = composerConnectorLogoUrls({ name: "Acme", serviceUrl: "https://mcp.example.com/sse" });
    expect(url).toContain("domain=example.com");
  });

  test("returns nothing for local servers with unknown names so a generic icon shows", () => {
    expect(composerConnectorLogoUrls({ name: "Local tools", serviceUrl: "http://localhost:3000" })).toEqual([]);
  });
});
