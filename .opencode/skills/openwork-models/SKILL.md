---
name: openwork-models
description: "Manage OpenWork inference models: add, remove, discount, validate aliases and overlays, or \"update the models\" from models.dev (triggers the update-models workflow and reports when its PR merges)."
---

# OpenWork Models

Files:

- Upstream source: `ee/apps/gateway/src/models/base.json`, map `openrouter.models`. Never read it into chat or edit it by hand.
- Editable list: `ee/apps/gateway/src/models/openwork-models.json`.
- Managed aliases: `packages/types/src/den/inference.ts` (`INFERENCE_MODEL_ALIASES`).
- `ee/apps/gateway/scripts/build-models.mjs` builds the overlay. `OPENWORK_DEV_MODE` picks `http://127.0.0.1:8791/api/v1`, else `https://inference.openworklabs.com/api/v1`.

Per **Use the Maintained Lever**, every change goes through the scripts:

```bash
S=.opencode/skills/openwork-models/scripts
node $S/extract-source-models.mjs --query "zai 5.1"      # search upstream into a temp file
node $S/openwork-models.mjs search "zai 5.1"
node $S/openwork-models.mjs add "z-ai/glm-5.1"           # copies the block, syncs aliases, validates
node $S/openwork-models.mjs remove "z-ai/glm-5.1"
node $S/openwork-models.mjs discount 0.1 "z-ai/glm-5.1" ["<id2>"]
node $S/openwork-models.mjs sync
node $S/openwork-models.mjs validate
node $S/trigger-update-workflow.mjs [--base dev --ref dev]
```

## Rules

- Resolve exact IDs first. No match: ask. Several plausible matches: list them and ask which.
- A usage factor is the charged fraction: `1` is full price, `0.1` is a 90% discount. Confirm IDs before any discount.
- New aliases get `displayName: "OpenWork: " + model.name`, `enabled: true`, `usageFactor: 1`. Sync preserves existing factors.
- "Update the models" means `trigger-update-workflow.mjs`. It dispatches `.github/workflows/update-models.yml`, waits for auto-merge and prints the merged PR. Report the PR, or "no changes" with the run URL, or the failed run/PR URL.
- Before finishing: `openwork-models.mjs validate` and `node ee/apps/gateway/scripts/build-models.mjs`.
