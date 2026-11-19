import { describe, expect, test } from "bun:test";
import { cloudMcpModelContext } from "../src/react-app/domains/connections/cloud-mcp-model-context";

const sessionModel = { providerID: "session-provider", modelID: "session-model" };
const workspaceModel = { providerID: "workspace-provider", modelID: "workspace-model" };
const orgModel = { providerID: "org-provider", modelID: "org-model" };
const globalModel = { providerID: "legacy-provider", modelID: "retired-model" };
const context = (model: typeof globalModel) => ({ provider: model.providerID, model: model.modelID });
const providerList = { all: [{ id: globalModel.providerID, models: { [globalModel.modelID]: {} } }] };

describe("Connect model context", () => {
  test("a conversation's choice wins over workspace, organization and stale global preferences", () => {
    expect(cloudMcpModelContext({ sessionModel, workspaceModel, orgModel, globalModel, providerList: { all: [] } }))
      .toEqual(context(sessionModel));
  });

  test("a workspace choice wins when the conversation has no remembered model", () => {
    expect(cloudMcpModelContext({ sessionModel: null, workspaceModel, orgModel, globalModel }))
      .toEqual(context(workspaceModel));
  });

  test("the organization default still wins over the app default", () => {
    expect(cloudMcpModelContext({ orgModel, globalModel, providerList })).toEqual(context(orgModel));
  });

  test("a global default is checked only if this engine actually lists it", () => {
    expect(cloudMcpModelContext({ globalModel, providerList })).toEqual(context(globalModel));
    expect(cloudMcpModelContext({ globalModel, providerList: { all: [] } })).toBeUndefined();
    expect(cloudMcpModelContext({ globalModel })).toBeUndefined();
    // A matching model id on another provider is not a match.
    expect(cloudMcpModelContext({ globalModel, providerList: { all: [
      { id: "another-provider", models: { [globalModel.modelID]: {} } },
    ] } })).toBeUndefined();
  });

  test("listed global models still reach the server even when they cannot call tools", () => {
    expect(cloudMcpModelContext({ globalModel, providerList: { all: [
      { id: globalModel.providerID, models: { [globalModel.modelID]: { capabilities: { toolcall: false } } } },
    ] } })).toEqual(context(globalModel));
  });

  test("explicit missing models are preserved for the server's real capability diagnostics", () => {
    for (const selection of [{ sessionModel: globalModel }, { workspaceModel: globalModel }, { orgModel: globalModel }]) {
      expect(cloudMcpModelContext({ ...selection, providerList: { all: [] } })).toEqual(context(globalModel));
    }
  });

  test("explicit Auto defaults retain their identity while access or catalog loading is pending", () => {
    const auto = { providerID: "openwork-free", modelID: "auto" };
    expect(cloudMcpModelContext({ workspaceModel: auto, globalModel })).toEqual(context(auto));
    expect(cloudMcpModelContext({ orgModel: auto, globalModel, providerList: { all: [] } })).toEqual(context(auto));
  });

  test("resolving a different model does not retain the previous context", () => {
    expect(cloudMcpModelContext({ sessionModel, workspaceModel, globalModel })).toEqual(context(sessionModel));
    expect(cloudMcpModelContext({ sessionModel: orgModel, workspaceModel, globalModel })).toEqual(context(orgModel));
    expect(cloudMcpModelContext({ workspaceModel, globalModel })).toEqual(context(workspaceModel));
    expect(cloudMcpModelContext({ globalModel, providerList: { all: [] } })).toBeUndefined();
  });

  test("empty selections cannot become malformed health requests", () => {
    expect(cloudMcpModelContext({})).toBeUndefined();
    expect(cloudMcpModelContext({ sessionModel: { providerID: " ", modelID: "model" } })).toBeUndefined();
    expect(cloudMcpModelContext({ workspaceModel: { providerID: "provider", modelID: "" } })).toBeUndefined();
  });
});
