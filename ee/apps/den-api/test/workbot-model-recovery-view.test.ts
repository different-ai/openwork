import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbotModelRecovery } from "@openwork/types/den/workbot-settings";
import { modelRecoveryView, MODELS_PAGE, WORKBOT_MODEL_PAGE } from "../../../packages/workbot-ui/src/model-recovery-state.ts";

const resetsAt = "2026-10-26T00:00:00.000Z";
const options = (overrides: Partial<WorkbotModelRecovery> = {}): WorkbotModelRecovery => ({
  canUpgrade: false, purchaseEligible: false, managedLuna: true, hasModelsSubscription: false, paidContinuation: "unavailable",
  upgradeBlockedReason: "paid_workbot_route_unavailable", canManageModels: false, canManageBilling: false, freeExhausted: true, freeResetsAt: resetsAt,
  ...overrides,
});
const billingAdmin = options({ canUpgrade: true, purchaseEligible: true, paidContinuation: "after_upgrade", upgradeBlockedReason: null, canManageModels: true, canManageBilling: true });

test("a billing admin out of free use gets OpenWork Models as the primary action, with reset and a way to keep working", () => {
  const view = modelRecoveryView("free_limit", billingAdmin);
  assert.equal(view.title, "You've used the free model allowance for now");
  assert.equal(view.resetsAt, resetsAt);
  assert.deepEqual(view.primary, { kind: "link", label: "Get OpenWork Models", path: MODELS_PAGE });
  assert.deepEqual(view.changeModel, { kind: "link", label: "Change model", path: WORKBOT_MODEL_PAGE });
  assert.equal(view.check, "check");
});

test("a member out of free use sees who can buy, never a purchase link", () => {
  const view = modelRecoveryView("free_limit", options());
  assert.equal(view.primary?.kind, "locked");
  assert.equal(view.primary?.label, "Ask an admin for OpenWork Models");
  assert.equal(view.changeModel, null);
});

test("an existing subscriber is never offered a second purchase", () => {
  const view = modelRecoveryView("free_limit", options({ hasModelsSubscription: true, canManageBilling: true }));
  assert.equal(view.primary, null);
  assert.match(view.note ?? "", /Your Models access isn’t ready yet/);
});

test("paid Luna that is ready replaces the purchase with continuation", () => {
  const view = modelRecoveryView("free_limit", { ...billingAdmin, hasModelsSubscription: true, paidContinuation: "authorized" });
  assert.equal(view.primary, null);
  assert.match(view.note ?? "", /Paid Luna is ready/);
});

test("billing that cannot be bought here shows no checkout, even to an admin", () => {
  const view = modelRecoveryView("free_limit", options({ canManageBilling: true, canManageModels: true }));
  assert.notEqual(view.primary?.label, "Get OpenWork Models");
  assert.deepEqual(view.primary, { kind: "link", label: "Review OpenWork Models", path: MODELS_PAGE });
  assert.equal(view.changeModel?.label, "Change model");
});

test("a model admin without purchase permission can review Models or change the model", () => {
  const view = modelRecoveryView("free_limit", options({ canManageModels: true }));
  assert.equal(view.title, "You've used the free model allowance for now");
  assert.equal(view.resetsAt, resetsAt);
  assert.deepEqual(view.primary, { kind: "link", label: "Review OpenWork Models", path: MODELS_PAGE });
  assert.deepEqual(view.changeModel, { kind: "link", label: "Change model", path: WORKBOT_MODEL_PAGE });
  // A billing-only person without model rights is not sent to a page they cannot change.
  assert.equal(modelRecoveryView("free_limit", options({ canManageBilling: true })).primary, null);
});

test("an unconfirmed free limit and unreadable options never offer an upgrade", () => {
  assert.equal(modelRecoveryView("free_limit", { ...billingAdmin, freeExhausted: false }).primary, null);
  assert.equal(modelRecoveryView("free_limit", undefined).primary, null);
  assert.equal(modelRecoveryView("free_limit", undefined).changeModel, null);
});

test("a workspace usage limit asks an admin for members and lets admins change the model", () => {
  const member = modelRecoveryView("usage_limit", options({ managedLuna: false, freeExhausted: false }));
  assert.equal(member.title, "Your workspace reached its model usage limit");
  assert.deepEqual(member.primary && { kind: member.primary.kind, label: member.primary.label }, { kind: "locked", label: "Ask an admin for more" });
  const admin = modelRecoveryView("usage_limit", options({ managedLuna: false, freeExhausted: false, canManageModels: true, canManageBilling: true }));
  assert.equal(admin.primary, null);
  assert.equal(admin.changeModel?.label, "Change model");
  assert.equal(admin.check, "retry");
});

test("a payment problem offers billing only to people with billing access", () => {
  assert.deepEqual(modelRecoveryView("payment_required", options({ canManageBilling: true })).primary, { kind: "link", label: "Manage billing", path: "billing" });
  assert.equal(modelRecoveryView("payment_required", options()).primary?.kind, "locked");
});
