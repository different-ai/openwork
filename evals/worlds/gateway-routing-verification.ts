import type { VerificationDictionary, VerificationEvaluator } from "@openwork/testkit";

// Five coherent claims; all expected values and readers are authored, never model-generated.
export const routingIntent = 'Verify these five conditions: the router Name field is editable; the router editor values exactly equal ["Daily work revised","Code review and debugging","Clear business writing","0.75"]; the saved API snapshot exactly equals {"count":1,"name":"Daily work revised","revision":2,"status":"active","categories":["Code review and debugging","Clear business writing"],"minConfidence":0.75}; the Gateway administrative link is absent; the technical details notice "Saved configuration only. No live request has been tested here." is visible.';
export const unsupportedRoutingIntent = "Verify a PDF invoice was exported to disk.";
export const routingDictionary: VerificationDictionary = {
  id: "gateway-routing-saved-editor", version: "4",
  checks: [
    { id: "editor", description: "The router Name field is editable", assertion: { kind: "see", target: { label: "Name" }, options: { editable: true } } },
    { id: "editor-snapshot", description: 'The router editor values exactly equal ["Daily work revised","Code review and debugging","Clear business writing","0.75"]', assertion: { kind: "observe", observation: { id: "router-editor-values", version: "1" }, path: [], predicate: { kind: "equals", value: ["Daily work revised", "Code review and debugging", "Clear business writing", "0.75"] } } },
    { id: "api-snapshot", description: 'The saved API snapshot exactly equals {"count":1,"name":"Daily work revised","revision":2,"status":"active","categories":["Code review and debugging","Clear business writing"],"minConfidence":0.75}', assertion: { kind: "observe", observation: { id: "saved-router-snapshot", version: "1" }, path: [], predicate: { kind: "equals", value: { count: 1, name: "Daily work revised", revision: 2, status: "active", categories: ["Code review and debugging", "Clear business writing"], minConfidence: 0.75 } } } },
    { id: "no-admin", description: "The Gateway administrative link is absent", assertion: { kind: "notSee", target: { role: "link", label: "Gateway" } } },
    { id: "not-live-verified", description: 'The technical details notice "Saved configuration only. No live request has been tested here." is visible', assertion: { kind: "see", target: { text: "Saved configuration only. No live request has been tested here." } } },
  ],
};
export const routingCheckIds = ["editor", "editor-snapshot", "api-snapshot", "no-admin", "not-live-verified"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRouterEditorValues(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((entry): entry is string => typeof entry === "string")) {
    throw new Error("Invalid router editor values observation");
  }
  return [...value];
}

/** Read-only projection: retain cardinality and category order; never repair observed values. */
export function normalizeSavedRouterSnapshot(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Invalid saved router observation");
  const router: unknown = value[0];
  if (!record(router) || typeof router.name !== "string" || typeof router.revision !== "number" || !Number.isSafeInteger(router.revision)
    || typeof router.status !== "string" || typeof router.minConfidence !== "number" || !Number.isFinite(router.minConfidence)
    || !Array.isArray(router.routes)) throw new Error("Invalid saved router observation");
  const categories = router.routes.map((route: unknown) => {
    if (!record(route) || typeof route.description !== "string") throw new Error("Invalid saved router category observation");
    return route.description;
  });
  return { count: value.length, name: router.name, revision: router.revision, status: router.status, categories, minConfidence: router.minConfidence };
}

/** Allowlist only typed probabilities, not arbitrary provider payloads or error bodies. */
export function routingAnswerMetadata(value: unknown) {
  const answers: Record<string, { type: "boolean"; probability: number }> = {};
  if (record(value) && record(value.answers)) {
    for (const [id, answer] of Object.entries(value.answers)) {
      if (/^(coverage|check_[0-4])$/.test(id) && record(answer) && answer.type === "boolean"
        && typeof answer.probability === "number" && Number.isFinite(answer.probability)
        && answer.probability >= 0 && answer.probability <= 1) answers[id] = { type: "boolean", probability: answer.probability };
    }
  }
  return { answers };
}

// CI selection fixture, NOT live Jev evidence. Unknown intents abstain.
export const offlineRoutingEvaluator: VerificationEvaluator = async ({ state, questions }) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, {
    type: "boolean", probability: Number(state.intent === routingIntent),
  }])),
});
