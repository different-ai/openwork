import { describe, expect, test } from "bun:test";
import {
  accessPeopleIds,
  managedAccessStatus,
  ownedAccessStatus,
  pluginShareSubtitle,
  sameAccess,
  shareConsequence,
  sharedToastDescription,
} from "../app/(den)/dashboard/_components/access-summary";
import { formatAddedDate } from "../app/(den)/dashboard/_components/item-dates";
import { brandHintFor } from "../app/(den)/dashboard/_components/item-logo";
import type { LibraryConnectionItem, LibraryItem, LibraryPluginItem } from "../app/(den)/dashboard/_components/library-data";
import {
  groupLibrary,
  isOwnedByViewer,
  libraryFilterOf,
  libraryItemDescription,
  parseLibraryFilter,
  receivedStatus,
} from "../app/(den)/dashboard/_components/library-view";

const directory = {
  members: [
    { id: "sam", user: { id: "u-sam", name: "Sam K.", email: "sam@example.com", image: null } },
    { id: "maya", user: { id: "u-maya", name: "Maya Chen", email: "maya@example.com", image: null } },
    { id: "ana", user: { id: "u-ana", name: "Ana Park", email: "ana@example.com", image: null } },
    { id: "lee", user: { id: "u-lee", name: "Lee Wong", email: "lee@example.com", image: null } },
  ],
  teams: [
    { id: "support", name: "Support", memberIds: ["ana", "lee", "maya"] },
    { id: "sales", name: "Sales", memberIds: ["lee"] },
  ],
};

const slack: LibraryConnectionItem = {
  type: "connection", id: "slack", name: "Slack", description: "Messages and channels", url: "https://mcp.example.com/slack",
  transport: "mcp", provider: null, state: "connected", connectedAt: null,
  edges: [{ kind: "person", sharedBy: { orgMembershipId: "sam", name: "Sam K." }, grantedAt: "2026-09-01T00:00:00.000Z" }],
};
const notes: LibraryConnectionItem = { ...slack, id: "notes", name: "Notes", edges: [{ kind: "org_wide" }] };
const prep: LibraryPluginItem = {
  type: "plugin", id: "prep", name: "Sales call prep", description: "Prep for a call — with extras",
  componentCount: 3, componentKinds: ["skill", "mcp", "command"], sourceRepositoryUrl: null,
  edges: [{ kind: "mine" }], role: "manager",
};
const replies: LibraryPluginItem = {
  ...prep, id: "replies", name: "Support replies", description: null, componentCount: 1, componentKinds: ["skill"],
  edges: [{ kind: "team", team: { id: "support", name: "Support" } }], role: "viewer",
};
const items: LibraryItem[] = [slack, notes, prep, replies];

describe("My Library groups", () => {
  test("filters by kind, where a one-skill plugin is a Skill", () => {
    expect(parseLibraryFilter("skills")).toBe("skills");
    expect(parseLibraryFilter("anything")).toBe("all");
    expect(libraryFilterOf(slack)).toBe("connectors");
    expect(libraryFilterOf(prep)).toBe("plugins");
    expect(libraryFilterOf(replies)).toBe("skills");
  });

  test("splits Added by you from From OpenWork, sorted by name, and filters by name", () => {
    const owned = new Set(["slack"]);
    const isMine = (item: LibraryItem) => isOwnedByViewer(item, "sam", owned);
    const all = groupLibrary({ items: [...items, slack], filter: "all", query: "", isMine });
    expect(all.mine.map((item) => item.name)).toEqual(["Sales call prep", "Slack"]);
    expect(all.received.map((item) => item.name)).toEqual(["Notes", "Support replies"]);
    const connectors = groupLibrary({ items, filter: "connectors", query: "", isMine });
    expect([...connectors.mine, ...connectors.received].map((item) => item.name)).toEqual(["Slack", "Notes"]);
    const named = groupLibrary({ items, filter: "all", query: "support", isMine });
    expect([...named.mine, ...named.received].map((item) => item.name)).toEqual(["Support replies"]);
  });

  test("a connector is yours when you added it, even before Den lists its access", () => {
    expect(isOwnedByViewer(slack, "sam", new Set())).toBe(true);
    expect(isOwnedByViewer(slack, "maya", new Set())).toBe(false);
    expect(isOwnedByViewer(notes, "sam", new Set(["notes"]))).toBe(true);
    expect(isOwnedByViewer(replies, "sam", new Set(["replies"]))).toBe(false);
  });

  test("says where received things came from in a few words", () => {
    expect(receivedStatus(notes.edges)).toBe("Everyone");
    expect(receivedStatus(replies.edges)).toBe("Support");
    expect(receivedStatus(slack.edges)).toBe("From Sam");
    expect(receivedStatus([])).toBe("Your organization");
  });

  test("keeps row descriptions short and plain", () => {
    expect(libraryItemDescription(prep)).toBe("Prep for a call");
    expect(libraryItemDescription(replies)).toBe("Skill");
    expect(libraryItemDescription({ ...slack, description: null })).toBe("Connector");
  });
});

describe("Who can use it wording", () => {
  const draft = { orgWide: false, memberIds: ["sam", "maya"], teamIds: ["support"] };

  test("counts each person once and never the owner", () => {
    expect(accessPeopleIds(draft, directory, "sam").sort()).toEqual(["ana", "lee", "maya"]);
    expect(accessPeopleIds({ orgWide: true, memberIds: [], teamIds: [] }, directory, "sam")).toHaveLength(3);
  });

  test("status lanes read Only you, Shared with, and Everyone", () => {
    expect(ownedAccessStatus(null, directory, "sam")).toBe("Only you");
    expect(ownedAccessStatus({ orgWide: false, memberIds: ["sam"], teamIds: [] }, directory, "sam")).toBe("Only you");
    expect(ownedAccessStatus(draft, directory, "sam")).toBe("Shared with Maya and Support");
    expect(ownedAccessStatus({ ...draft, orgWide: true }, directory, "sam")).toBe("Everyone");
    expect(managedAccessStatus({ orgWide: false, memberIds: [], teamIds: ["sales", "support"] }, directory, null)).toBe("Sales and Support");
  });

  test("the share footer and toast say who gets it", () => {
    expect(shareConsequence(draft, directory, "sam")).toBe("Maya and Support will find it in My Library.");
    expect(sharedToastDescription(draft, directory, "sam")).toBe("3 people can use it now.");
    expect(sharedToastDescription({ orgWide: false, memberIds: ["sam"], teamIds: ["sales"] }, directory, "sam")).toBe("1 person in Sales can use it now.");
    expect(sameAccess(draft, { orgWide: false, memberIds: ["maya", "sam"], teamIds: ["support"] })).toBe(true);
    expect(sameAccess(draft, { ...draft, teamIds: [] })).toBe(false);
  });

  test("a plugin share says what people get and whose account they use", () => {
    const connector = { id: "c1", name: "HubSpot", description: "", url: "https://mcp.example.com/hubspot" };
    const skill = { id: "s1", name: "Prep", description: "" };
    const command = { id: "k1", name: "follow-up", description: "" };
    expect(pluginShareSubtitle({ skills: [skill], commands: [command], mcps: [connector] }))
      .toBe("They get the skill, the command and HubSpot. Each person uses their own HubSpot account.");
    expect(pluginShareSubtitle({ skills: [], commands: [], mcps: [] })).toBe("They get everything inside it.");
  });
});

describe("item details", () => {
  test("Added dates read Today, Yesterday, or a short date", () => {
    const now = new Date("2026-09-23T15:00:00");
    expect(formatAddedDate("2026-09-23T09:00:00", now)).toBe("Today");
    expect(formatAddedDate("2026-09-22T09:00:00", now)).toBe("Yesterday");
    expect(formatAddedDate("2026-09-03T09:00:00", now)).toBe("Sep 3");
    expect(formatAddedDate(null, now)).toBe("");
  });

  test("named brands get their real logo, while local test servers do not", () => {
    expect(brandHintFor("Slack", "http://127.0.0.1:4100/mcp")).not.toEqual({});
    expect(brandHintFor("Notes", "http://127.0.0.1:4100/mcp")).toEqual({});
  });
});
