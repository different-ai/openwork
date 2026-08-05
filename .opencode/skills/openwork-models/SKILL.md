---
name: micx-models
description: Manage Micx inference model aliases, micx model overlays, discounts, validation, and automated base model refreshes from models.dev. Use when adding, removing, discounting, auditing, or updating Micx models, including requests like "update the models" that should trigger the GitHub update-models workflow and report when its PR merges.
---

# Micx Models

Use this skill for Micx inference model changes. The source of truth for
available upstream models is:

- `ee/apps/inference/src/models/base.json`
- provider key: `openrouter`
- model map: `openrouter.models`

The editable Micx model list is:

- `ee/apps/inference/src/models/micx-models.json`

Managed file:

- `packages/types/src/den/inference.ts`

`ee/apps/inference/scripts/build-models.mjs` reads `micx-models.json` and
generates the Micx provider overlay in memory. It selects the API URL from
`MICX_DEV_MODE`: dev uses `http://127.0.0.1:8791/api/v1`, otherwise prod
uses `https://inference.micxlabs.com/api/v1`.

Do not inspect the full `base.json` in chat. Use the scripts so the large source
model body stays out of context.

## Scripts

Extract/search source models into a temp file:

```bash
node .opencode/skills/micx-models/scripts/extract-source-models.mjs
node .opencode/skills/micx-models/scripts/extract-source-models.mjs --query "zai 5.1"
```

Manage Micx models:

```bash
node .opencode/skills/micx-models/scripts/micx-models.mjs search "zai 5.1"
node .opencode/skills/micx-models/scripts/micx-models.mjs add "z-ai/glm-5.1"
node .opencode/skills/micx-models/scripts/micx-models.mjs remove "z-ai/glm-5.1"
node .opencode/skills/micx-models/scripts/micx-models.mjs discount 0.1 "z-ai/glm-5.1"
node .opencode/skills/micx-models/scripts/micx-models.mjs sync
node .opencode/skills/micx-models/scripts/micx-models.mjs validate
```

Trigger the remote base model refresh workflow:

```bash
node .opencode/skills/micx-models/scripts/trigger-update-workflow.mjs
node .opencode/skills/micx-models/scripts/trigger-update-workflow.mjs --base dev --ref dev
```

## Update Models Workflow

When the user asks to update/refresh/sync the models from models.dev, do not edit
`base.json` manually. Trigger `.github/workflows/update-models.yml` and wait for
the result:

```bash
node .opencode/skills/micx-models/scripts/trigger-update-workflow.mjs
```

The script dispatches the manual workflow, watches the run, finds the automation
PR, waits until auto-merge completes, and prints the merged PR URL. If the
workflow finds no model changes, report that no PR was created and include the
workflow run URL. If the workflow or PR fails/closes unmerged, report that
failure with the run/PR URL.

## Add Workflow

1. Run `extract-source-models.mjs --query "<user text>"` or
   `micx-models.mjs search "<user text>"`.
2. If there is no good match, ask the user for clarification.
3. If there are multiple plausible matches, list the matching IDs and ask which
   one(s) to add.
4. Once exact IDs are known, run `micx-models.mjs add "<id>"` for each ID.
   The script copies the full model block from `openrouter.models`, adds it to
   `micx-models.json`, syncs aliases, and validates.

New aliases use:

```ts
"model/id": {
  upstreamModel: "model/id",
  displayName: "Micx: " + model.name,
  enabled: true,
  usageFactor: 1,
}
```

Preserve existing `usageFactor` values when syncing. New models default to `1`.

## Remove Workflow

1. Resolve exact IDs with `search` if needed.
2. Run `micx-models.mjs remove "<id>"`.
3. The script removes the model from `micx-models.json`, removes the alias
   by regenerating the alias map from the model list, and validates.

## Discount Workflow

A usage factor is the charged fraction of normal price:

- `1` means 100% price.
- `0.1` means 10% price, a 90% discount.

Always clarify exact model IDs before changing discounts, especially if the user
provides a partial string or asks for multiple models. Then run:

```bash
node .opencode/skills/micx-models/scripts/micx-models.mjs discount <factor> "<id>" ["<id2>"]
```

## Validation

Before finishing, run:

```bash
node .opencode/skills/micx-models/scripts/micx-models.mjs validate
node ee/apps/inference/scripts/build-models.mjs
```

Validation checks JSON validity, Micx model ID consistency, and alias
coverage in `INFERENCE_MODEL_ALIASES`.
