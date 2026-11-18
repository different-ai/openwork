import { expect, test } from "bun:test";
import { newChatDefaultModel, orgDefaultModelForEngine } from "../src/react-app/domains/models/org-default-model";

const orgModel = { providerID: "openwork", modelID: "moonshotai/kimi-k3", source: "organization" as const };
const teamModel = { providerID: "lpr_01k0000000000000000000001", modelID: "opus", source: "team" as const, teamName: "Research" };
const v2 = "http://127.0.0.1:4096/w/ws_1/opencode2";
const v1 = "http://127.0.0.1:4096/w/ws_1/opencode";

test("only the OpenCode v2 engine picks up the organization's default model", () => {
  expect(orgDefaultModelForEngine(orgModel, v2)).toEqual({ providerID: "openwork", modelID: "moonshotai/kimi-k3" });
  expect(orgDefaultModelForEngine(teamModel, `${v2}/`)).toEqual({ providerID: teamModel.providerID, modelID: "opus" });
  // v1, or an engine not known yet, is untouched.
  expect(orgDefaultModelForEngine(orgModel, v1)).toBeNull();
  expect(orgDefaultModelForEngine(orgModel, null)).toBeNull();
  expect(orgDefaultModelForEngine(orgModel, "")).toBeNull();
  // Feature off: Den sends no default model.
  expect(orgDefaultModelForEngine(undefined, v2)).toBeNull();
});

test("a new chat starts on the member's own workspace pick, then the organization's, then the app's default", () => {
  const own = { model: { providerID: "anthropic", modelID: "claude" }, variant: "high" };
  const app = { model: { providerID: "openwork-free", modelID: "auto" }, variant: "low" };
  const org = { providerID: "openwork", modelID: "moonshotai/kimi-k3" };
  expect(newChatDefaultModel({ workspaceDefault: own, orgDefault: org, appDefault: app })).toEqual(own);
  expect(newChatDefaultModel({ workspaceDefault: null, orgDefault: org, appDefault: app })).toEqual({ model: org, variant: null });
  expect(newChatDefaultModel({ workspaceDefault: null, orgDefault: null, appDefault: app })).toEqual(app);
  // v1 resolves no organization model, so its new chats start exactly as before.
  expect(newChatDefaultModel({ workspaceDefault: null, orgDefault: orgDefaultModelForEngine(orgModel, v1), appDefault: app })).toEqual(app);
});
