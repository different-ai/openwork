import { describe, expect, test } from "bun:test";
import { accessAddedToast } from "../app/(den)/dashboard/_components/access-summary";
import { connectorSetupUnfinished, finishSetupHref, signInSentence } from "../app/(den)/dashboard/_components/admin-connectors";

const org = {
  members: [
    { id: "riley", user: { name: "Riley Admin", email: "riley@example.com" } },
    { id: "omar", user: { name: "Omar Diaz", email: "omar@example.com" } },
    { id: "tess", user: { name: "Tess Morgan", email: "tess@example.com" } },
    { id: "ana", user: { name: "Ana Park", email: "ana@example.com" } },
  ],
  teams: [
    { id: "sales", name: "Sales", memberIds: ["omar", "tess"] },
    { id: "support", name: "Support", memberIds: ["ana"] },
  ],
};

describe("Manage › Connectors", () => {
  test("an org account nobody signed in to yet is setup not finished", () => {
    expect(connectorSetupUnfinished({ setupRequired: false, credentialMode: "shared", authType: "oauth", connected: false })).toBe(true);
    expect(connectorSetupUnfinished({ setupRequired: false, credentialMode: "shared", authType: "oauth", connected: true })).toBe(false);
    expect(connectorSetupUnfinished({ setupRequired: false, credentialMode: "per_member", authType: "oauth", connected: false })).toBe(false);
    expect(connectorSetupUnfinished({ setupRequired: false, credentialMode: "shared", authType: "none", connected: false })).toBe(false);
    expect(connectorSetupUnfinished({ setupRequired: true, credentialMode: "per_member", authType: "oauth", connected: false })).toBe(true);
  });

  test("Finish signs in on the connector page, and sends OAuth apps and keys to the full editor", () => {
    expect(finishSetupHref("acme", { id: "emc_1", authType: "oauth", oauthClientRequired: false, oauthClientConfigured: false }))
      .toBe("/dashboard/mcp-connections/emc_1");
    expect(finishSetupHref("acme", { id: "emc_1", authType: "oauth", oauthClientRequired: true, oauthClientConfigured: false }))
      .toBe("/dashboard/mcp-connections/all/emc_1");
    expect(finishSetupHref("acme", { id: "emc_2", authType: "apikey" }))
      .toBe("/dashboard/mcp-connections/all/emc_2");
  });

  test("the page says how people sign in, in plain words", () => {
    expect(signInSentence({ name: "Slack", authType: "oauth", credentialMode: "per_member" })).toBe("Each person signs in with their own Slack account");
    expect(signInSentence({ name: "Slack", authType: "oauth", credentialMode: "shared" })).toBe("Everyone uses one Slack account");
    expect(signInSentence({ name: "Docs", authType: "none", credentialMode: "shared" })).toBe("No sign-in needed");
  });

  test("adding teams names them and counts the people they reach; removing says nothing", () => {
    const before = { orgWide: false, memberIds: ["riley"], teamIds: [] };
    expect(accessAddedToast(before, { ...before, teamIds: ["sales", "support"] }, org, "riley"))
      .toEqual({ title: "Sales and Support can use it now", description: "3 people will find it in My Library." });
    expect(accessAddedToast({ ...before, teamIds: ["sales"] }, before, org, "riley")).toBeNull();
    expect(accessAddedToast(before, { ...before, orgWide: true }, org, "riley"))
      .toEqual({ title: "Everyone can use it now", description: "They will find it in My Library." });
  });
});
