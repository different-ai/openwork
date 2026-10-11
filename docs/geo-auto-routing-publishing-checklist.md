# Auto routing guide publishing checklist

Reviewed 2026-10-10 against draft [#5100](https://github.com/different-ai/openwork/pull/5100), its body, and the router README, evaluator, and shared schema diff. This is editorial copy about a proposal, not a feature rollout or production verification.

The section belongs in the existing `/guides/control-ai-costs` guide in `ee/apps/landing/lib/guides.ts`. Keep the current spend-limit, usage, and lower-cost-model guidance. Keep the routing badge **Planned preview** and the explicit **not currently publicly available** statement until the blockers below are cleared. Do not describe routing as live in the hero, metadata, index, or calls to action.

## Blockers before claiming availability

- [ ] #5100 is merged, and the shipped implementation is reviewed against the copy. A draft PR or its test screenshots are not evidence of public availability.
- [ ] Feature declaration, deployment scope, organization rollout, and kill-switch behavior are verified under the feature-registry workflow. Confirm who can actually use it and on which clients; do not infer automatic router sync or Electron parity from app-web tests.
- [ ] Product owners verify the final product name and intended use claims. “Auto routing” is provisional editorial terminology; distinguish it from the free Auto starter model, which is a single model.
- [ ] Consent is verified in the shipped flow: it names the latest user text (up to 16,000 characters), category descriptions, external Jev processing through Vercel AI Gateway, and the associated data-sharing risk. Consent alone does not make restricted data permissible to share.
- [ ] The classifier privacy/security assessment approves applicable data handling, retention, subprocessors, processing locations, and organizational policy requirements. Do not promise privacy-sensitive data can safely go to an external classifier. If external classification is prohibited, direct selection of an approved private model is the alternative.
- [ ] Provider compatibility tests pass on the shipped revision: OpenAI-compatible chat completions only, including any claimed private endpoint. Do not extend claims to native Anthropic/Google protocols, Responses API, embeddings, or arbitrary local endpoints without new implementation and evidence.
- [ ] Tests verify member ownership and organization scoping, current model grants on every dispatch, fallback authorization, revocation, and disable behavior. Do not recast member-owned routers as admin-owned shared policies.
- [ ] Tests verify 2–12 human-described categories, one model per category, latest-user-text-only classification, the 16,000-character limit, configurable minimum confidence, no-match handling, and the five-second timeout. Verify that invalid classifier output, missing credentials, and revoked access do not silently choose a different destination.
- [ ] Billing is reviewed: classifier evaluation is separately billed to the operator's AI Gateway account, not included in completion usage. Measure total classification plus completion costs before claiming savings or implying existing completion limits cap classifier charges.

## Copy and publication checks

- [ ] Keep the routine/hard/confidential example illustrative. The confidential category uses only sanitized text approved for external classification; it is not a privacy, DLP, or access-control guarantee. A private completion destination alone is insufficient because classification happens first.
- [ ] Verify all completion targets, the classifier, and the private fallback are approved. Explain that the completion target receives the original conversation even though the classifier sees only the latest user text and category descriptions.
- [ ] Preserve the three FAQ answers' availability, privacy, and billing qualifications. HTML, Markdown, and FAQPage/Article schema derive from the same guide content; review each rendered representation rather than hand-editing separate schema or Markdown copies.
- [ ] Run the landing TypeScript check and `git diff --check`. Inspect the rendered guide and attach screenshots when this copy enters a PR, following DESIGN.md P1 (truthful planned state), P5 (existing guide components), P9 (named data sharing), and P10 (visual evidence).
- [ ] Update the factual review date and this checklist when the product changes. Only replace **Planned preview** with a verified availability label after all relevant blockers are resolved.
