import { describe, expect, test } from "bun:test";

import {
  parseDenLibraryAccessGrants,
  parseDenLibraryConfigObjectVersion,
  parseDenLibraryItems,
  parseDenLibraryOrgDirectory,
  parseDenLibraryPluginFiles,
  parseDenPluginListAccess,
} from "../src/app/lib/den-library";
import { parseSkillMarkdown, skillMarkdown } from "../src/react-app/domains/settings/library";
import {
  isOwnedLibraryPlugin,
  libraryAudienceFromGrants,
  libraryAudienceName,
  libraryAudiencePeopleCount,
  libraryCloudItemTaxonomy,
  libraryConnectionAudience,
  libraryOwnedCaption,
  librarySharedByCaption,
} from "../src/react-app/domains/settings/library-sharing";
import { targetsFor } from "../src/react-app/domains/settings/pages/library-share-page";

const directory = parseDenLibraryOrgDirectory({
  currentMember: { id: "member-owner" },
  members: [
    { id: "member-owner", user: { name: "Sam K.", email: "owner@example.test" } },
    { id: "member-a", user: { name: "Alex", email: "a@example.test" } },
    { id: "member-b", user: { name: "", email: "b@example.test" } },
  ],
  teams: [{ id: "team-support", name: "Support", memberIds: ["member-a", "member-b", "member-owner"] }],
});

describe("Den Library payloads", () => {
  test("items keep their kind, role and how they reached the member", () => {
    const items = parseDenLibraryItems({
      items: [
        {
          type: "plugin",
          id: "plugin-1",
          name: "Customer briefing",
          description: null,
          componentKinds: ["skill"],
          componentCount: 1,
          role: "manager",
          edges: [{ kind: "mine" }, { kind: "person", sharedBy: { orgMembershipId: "member-a", name: "Alex" }, grantedAt: "2026-09-01" }],
        },
        {
          type: "connection",
          id: "conn-1",
          name: "Google Workspace",
          url: "https://workspace.example.test/mcp",
          transport: "native",
          state: "needs_signin",
          edges: [{ kind: "team", team: { id: "team-support", name: "Support" } }, { kind: "catalog", marketplace: { name: "Starter" } }],
        },
        { type: "unknown", id: "x", name: "x" },
      ],
    });
    expect(items).toHaveLength(2);
    const [plugin, connection] = items;
    expect(plugin?.type === "plugin" && isOwnedLibraryPlugin(plugin)).toBe(true);
    expect(plugin?.edges[1]).toEqual({ kind: "person", sharedById: "member-a", sharedByName: "Alex", grantedAt: "2026-09-01" });
    expect(connection?.type === "connection" ? connection.state : null).toBe("needs_signin");
    expect(connection?.edges).toEqual([
      { kind: "team", teamId: "team-support", teamName: "Support" },
      { kind: "catalog", marketplaceName: "Starter" },
    ]);
  });

  test("grants skip removed rows; files and versions read their ids", () => {
    const grants = parseDenLibraryAccessGrants({
      items: [
        { id: "g1", teamId: "team-support", role: "viewer" },
        { id: "g2", orgMembershipId: "member-a", role: "viewer", removedAt: "2026-09-02" },
        { id: "g3", orgWide: true, role: "viewer" },
      ],
    });
    expect(grants.map((grant) => grant.id)).toEqual(["g1", "g3"]);
    expect(parseDenLibraryPluginFiles({ items: [{ configObjectId: "co-1", configObject: { objectType: "skill", title: "customer-briefing" } }] }))
      .toEqual([{ configObjectId: "co-1", objectType: "skill", title: "customer-briefing", description: null, rawSourceText: null }]);
    expect(parseDenLibraryConfigObjectVersion({ item: { id: "v1", rawSourceText: "---" } })).toEqual({ id: "v1", rawSourceText: "---" });
    expect(directory.members.map((member) => member.name)).toEqual(["Sam K.", "Alex", "b@example.test"]);
  });

  test("the plugin list carries active grants only for plugins the member manages", () => {
    const access = parseDenPluginListAccess({
      items: [
        {
          id: "plugin-managed",
          access: [
            { id: "g1", teamId: "team-support", role: "viewer" },
            { id: "g2", orgWide: true, role: "viewer", removedAt: "2026-09-02" },
          ],
        },
        { id: "plugin-shared-with-me" },
        { id: "plugin-not-shared", access: [] },
      ],
    });
    expect([...access.keys()]).toEqual(["plugin-managed", "plugin-not-shared"]);
    expect(access.get("plugin-managed")?.map((grant) => grant.id)).toEqual(["g1"]);
    expect(access.get("plugin-not-shared")).toEqual([]);
    expect(parseDenPluginListAccess({ ok: false }).size).toBe(0);
  });
});

describe("Library sharing words", () => {
  test("an audience is read from grants, without the owner", () => {
    const audience = libraryAudienceFromGrants(
      parseDenLibraryAccessGrants({
        items: [
          { id: "g0", orgMembershipId: "member-owner", role: "manager" },
          { id: "g1", teamId: "team-support", role: "viewer" },
        ],
      }),
      directory,
    );
    expect(audience).toEqual({ orgWide: false, teams: [{ id: "team-support", name: "Support", peopleCount: 3, grantId: "g1" }], people: [] });
    expect(libraryAudienceName(audience)).toBe("Support");
    // Distinct people besides the owner.
    expect(libraryAudiencePeopleCount(audience, directory)).toBe(2);
    expect(targetsFor(audience)).toEqual([{ kind: "team", id: "team-support" }]);
  });

  test("row captions say who has it and whether it just changed", () => {
    const justMe = { orgWide: false, teams: [], people: [] };
    const support = { orgWide: false, teams: [{ id: "t", name: "Support", peopleCount: 5, grantId: "g" }], people: [] };
    expect(libraryOwnedCaption(justMe, false)).toBe("Just me");
    expect(libraryOwnedCaption(support, false)).toBe("Shared with Support");
    expect(libraryOwnedCaption(support, true)).toBe("Changed just now · Support has it");
    expect(libraryAudienceName({ ...support, people: [{ id: "p", name: "Alex", grantId: null }] })).toBe("Support and Alex");
  });

  test("single skills and connectors read as themselves; bundles read as plugins", () => {
    expect(libraryCloudItemTaxonomy(["skill"], 1)).toBe("skill");
    expect(libraryCloudItemTaxonomy(["mcp"], 1)).toBe("connection");
    expect(libraryCloudItemTaxonomy(["skill"], 2)).toBe("plugin");
    expect(libraryCloudItemTaxonomy(["mcp", "skill"], 2)).toBe("plugin");
  });

  test("shared items name who shared them; connections name who else can use them", () => {
    expect(librarySharedByCaption({ edges: [{ kind: "person", sharedById: "m", sharedByName: "Alex", grantedAt: null }] }, "OpenWork")).toBe("Shared by Alex");
    expect(librarySharedByCaption({ edges: [] }, "OpenWork")).toBe("From OpenWork");
    expect(libraryConnectionAudience([{ kind: "org_wide" }], "OpenWork")).toBe("Everyone in OpenWork");
    expect(libraryConnectionAudience([{ kind: "team", teamId: "t", teamName: "Support" }], "OpenWork")).toBe("People in Support");
  });

  test("a skill file round-trips through its frontmatter", () => {
    const raw = skillMarkdown("customer-briefing", "Before a customer call", "Read my calendar.");
    expect(parseSkillMarkdown(raw)).toEqual({ name: "customer-briefing", description: "Before a customer call", body: "Read my calendar." });
  });
});
