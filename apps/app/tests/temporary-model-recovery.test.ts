import { afterEach, expect, test } from "bun:test";
import { newChatDefaultModel } from "../src/react-app/domains/models/org-default-model";
import { modelRecoveryChatKey, temporaryRecoveredDefault, useModelRecoveryStore } from "../src/react-app/domains/session/surface/model-recovery-store";

const previous = { providerID: "ipr_org", modelID: "gwm_old" };
const replacement = { providerID: "ipr_org", modelID: "gwm_fallback" };
const orgNext = { providerID: "ipr_org", modelID: "gwm_next" };
const appDefault = { model: previous, variant: "high" };
const key = modelRecoveryChatKey("account/workspace");
afterEach(() => useModelRecoveryStore.setState({ byChat: {} }));

test("automatic new-chat recovery is temporary, leaving the next organization default above app preferences", () => {
  const configured = newChatDefaultModel({ workspaceDefault: null, orgDefault: previous, appDefault });
  const defaultSelectionKey = JSON.stringify(configured);
  useModelRecoveryStore.getState().record(key, { previous, replacement, defaultSelectionKey });
  const recovery = useModelRecoveryStore.getState().byChat[key];
  expect(temporaryRecoveredDefault(configured, recovery, defaultSelectionKey)).toEqual({ model: replacement, variant: null });
  const next = newChatDefaultModel({ workspaceDefault: null, orgDefault: orgNext, appDefault });
  expect(temporaryRecoveredDefault(next, recovery, JSON.stringify(next))).toEqual({ model: orgNext, variant: null });
  expect(appDefault).toEqual({ model: previous, variant: "high" });
});

test("an explicit personal choice retains precedence while recovery never crosses account/workspace/chat scopes", () => {
  const personal = { model: previous, variant: "low" };
  const configured = newChatDefaultModel({ workspaceDefault: personal, orgDefault: orgNext, appDefault });
  const defaultSelectionKey = JSON.stringify(configured);
  useModelRecoveryStore.getState().record(key, { previous, replacement, defaultSelectionKey });
  const recovery = useModelRecoveryStore.getState().byChat[key];
  expect(temporaryRecoveredDefault(configured, recovery, defaultSelectionKey).model).toEqual(replacement);
  expect(temporaryRecoveredDefault(configured, undefined, defaultSelectionKey)).toEqual(personal);
  expect(useModelRecoveryStore.getState().byChat[modelRecoveryChatKey("another-account/workspace")]).toBeUndefined();
  expect(useModelRecoveryStore.getState().byChat[modelRecoveryChatKey("account/another-workspace")]).toBeUndefined();
  expect(useModelRecoveryStore.getState().byChat[modelRecoveryChatKey("account/workspace", "another-chat")]).toBeUndefined();
  expect(temporaryRecoveredDefault(configured, recovery, "explicit-choice-changed")).toEqual(personal);
  useModelRecoveryStore.getState().dismiss(key);
  expect(temporaryRecoveredDefault(configured, useModelRecoveryStore.getState().byChat[key], defaultSelectionKey).model).toEqual(replacement);
  useModelRecoveryStore.getState().clear(key);
  expect(temporaryRecoveredDefault(configured, useModelRecoveryStore.getState().byChat[key], defaultSelectionKey)).toEqual(personal);
});
