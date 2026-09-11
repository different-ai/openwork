# Model intelligence and selection preferences

Policy reviewed September 9, 2026. This index describes documented metadata and
product preferences, **not a model leaderboard or measured speed/quality**.

## Three separate owners

1. `src/lib/model-intelligence-index.ts` owns versioned provider/adapter contracts,
   source links, task criteria, and priority ordering. Its criteria drive selection.
2. `src/lib/model-intelligence.ts` normalizes observed engine facts and evaluates
   candidates. `connectedModelCatalog` supplies only connected models. Facts are
   refreshed by ordinary catalog reads; no new credential or polling service exists.
3. Each `coworker.md` owns `modelSelectionPreferences`: priority, ordered preferred
   quick/deep IDs, and avoided IDs. Preferences save explicitly in model settings
   and do not alter the selected model, Fixed/Automatic mode, or effort dial.

The model picker exposes facts, source-policy version, observation time and reasons.
Local observation time does not establish upstream freshness. Provider options,
headers, endpoint URLs, tokens and conversation contents are never indexed.

## Provider contracts to keep distinct

| Service / adapter | Useful evidence | Do not infer |
|---|---|---|
| OpenRouter / `@openrouter/ai-sdk-provider` | Model IDs with publisher namespaces, modalities, context limits, supported parameters, pricing | The top provider is every route; a chosen model pins its serving provider; retention or residency follows from the model name |
| OpenAI / `@ai-sdk/openai` | Model listing establishes identifiers and access; capability/pricing enrichment needs additional metadata | `/models` alone supplies context, reasoning, tools, quality or prices |
| Anthropic / `@ai-sdk/anthropic` | Current list API can report nullable capability objects and token limits | Null means unsupported; list metadata includes pricing or universal model quality |
| Google AI / `@ai-sdk/google` | Model generation methods, limits and thinking fields when reported | `generateContent` proves every modality, tool or schema feature |
| Vertex / `@ai-sdk/google-vertex` | Distinct integration with its own project/region/access | Google AI credentials or availability are interchangeable with Vertex |
| `@ai-sdk/openai-compatible` | OpenAI-compatible transport | The endpoint is OpenAI or inherits its auth, privacy or model capabilities |

An SDK adapter is integration code, not an authenticated provider. Registry
matches use exact provider IDs and are labelled as registry defaults. Custom or
managed connection names remain their own authorization boundary. OpenRouter
IDs keep their full publisher/model suffix; the first slash separates the engine
provider from the model, not the last slash.

## Facts and units

The index preserves tools, reasoning and input/output modalities as true, false
or unknown. Context, input and output limits stay separate. Prices must be finite
nonnegative numbers reported by the engine; zero is valid but missing is unknown.
The index cannot recover provenance that an upstream engine has already discarded.

Engine prices are **per million tokens**. Raw OpenRouter prompt/completion price
strings are **per token**; they must not be passed directly into this normalizer
or multiplied again after engine conversion. Cache, request, image, search and
conditional charges are not total-cost estimates here. The equal-or-lower gate
compares the two reported text token rates only.

## Decision order

1. Preserve exact coworker overrides and explicit app role models. Automatic
   preferences never replace an intentional exact choice. Conversation app
   inheritance is resolved before the retained coworker override.
   An explicit app effort no longer offered by its model refuses selection;
   the facilitator may use its deterministic scorer, never another effort.
2. Resolve the exact standard anchor. An explicitly missing/excluded/avoided
   anchor does not authorize a replacement or a provider-failure retry.
3. Restrict substitutions to the same connected engine provider and both known
   token rates no higher than the anchor. Require confirmed tools and active
   status; preserve the anchor's known modalities and input/context/output limits.
4. Rank using the versioned task criteria. Quick prefers confirmed non-reasoning;
   deep prefers confirmed reasoning and known capacity; standard keeps the anchor.
   Balanced uses task criteria. Lower token cost puts cost first; More documented
   capacity puts reported context/output capacity first. Neither measures quality.
5. Preferred IDs are soft ordered preferences after safety gates; avoided IDs
   exclude automatic candidates. Lists are limited to eight exact IDs each.
6. Use deterministic ties and prefer continuity. Explain why the model was kept
    or changed. Pin the native model at admission; do not re-rank a running turn.

This conservative initial policy preserves all known anchor limits rather than
estimating a smaller context requirement from the latest message alone. A cheaper
model with lower limits may therefore remain ineligible even for a short prompt.

Private discussion and native group/review paths share `resolveDiscussionModel`.
Inherited conversations use the app's exact model or the quick policy around the
coworker's anchor/recommendation; explicit depth still affects effort. Assignments
retain their standard model. New Workers resolve coworker role override, app role
default, then deep (thinking) or standard (delivery) around the owner anchor, and
pin the result. Existing Worker snapshots and legacy unpinned execution are unchanged.
The facilitator honors group override then app choice, otherwise quick selection;
automatic secondary attempts stay with the same provider at no higher known prices.
Memory/progress transport allowlists, budgets and opt-in settings are unchanged.

## Updating the index

- Review the official source for the affected service or adapter. Update the
  source-linked contract and version/review date together; never invent model
  scores from marketing names, release dates, or an SDK capability table.
- Put factual enrichment in the catalog normalizer with unknown states and units.
  Keep rankings in task/priority policy and personal choices in coworker records.
- Extend the existing model-choice/catalog check for the changed gate, including
  its negative case (unknown metadata, another provider, higher price, fixed pin).
- Verify actual dispatch through the covering team/group journey before claiming
  native proof. Colocated checks and picker previews alone are not runtime proof.
- Keep source review distinct from live catalog observation. No automatic web
  research, benchmark spending, outcome learning, or remote policy replacement is
  enabled by this index. Those require separate design and authority.

## Official references

- [OpenRouter models](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [AI SDK providers and models](https://ai-sdk.dev/docs/foundations/providers-and-models)
- [OpenAI model listing](https://developers.openai.com/api/reference/resources/models/methods/list)
- [Anthropic model listing](https://platform.claude.com/docs/en/api/models/list)
- [Google Gemini models](https://ai.google.dev/api/models)

OpenRouter's provider `only`, `order`, `allow_fallbacks`, `require_parameters`,
`data_collection`, and `zdr` controls belong to request/connection routing policy.
This selector does not change them. Same engine provider does not imply the same
downstream endpoint, billing totals, retention policy, or data residency.
