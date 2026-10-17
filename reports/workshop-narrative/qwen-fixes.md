# Qwen fixed-baseline verification — pending

This is the separate Qwen phase, stacked on the Sol fix branch. No Qwen-specific source, prompt, fixture, assertion or limit changes have been made before its first fixed-baseline run.

## Comparison contract

- Sol tested source: `8d40f1bba1275419d222a359fe8479a842dfe373`; native **12 PASS / 0 FAIL / 0 BLOCKED**, exit 0. Independent technical rehearsal audit accepted all outcomes with the explicit scope/quality limits in [sol-fixes.md](./sol-fixes.md) and [sol-fixed.json](./sol-fixed.json).
- Sol branch publication checkpoint: `90465cca96` (report-only descendant; unchanged tested code/fixture digests).
- Required common proof/fixture digest: `91de4685beced9be82ddd39efd2d8c0382c1d93b55a6aada13d77e2cd93dd0af`.
- Required common scene-prompt/limit digest: `d340142b2ff0286d0e8a7b4ded3a651c23b61c49fc132b42ec902470d94f93c0`.
- Required initial business-state digest: `d42c2d0d10c5a0977df87d8c35cdb4fa2b97e8ae49d12d49d3399ffdf6bbe0e2`.
- Exact Qwen subject: `qwen/qwen3.8-27b`, OpenRouter Chat Completions, default variant. No stronger fallback, no inherited GPT Fast claim, no installed-provider edits.
- All twelve scenes, actual recipient execution, existing feedback form/provider persistence, downloaded-byte artifact validation and real Docshot primitives remain required. Failed/blocked scenes remain in order and fail the native aggregate.

## First command

```sh
OPENWORK_WORKSHOP_PROFILE=qwen-27b \
OPENWORK_WORKSHOP_GPT_PHASE_DONE=1 \
OPENWORK_WORKSHOP_NARRATIVE=1 \
OPENWORK_WORKSHOP_PYTHON='<private-Python-with-python-pptx>' \
OPENWORK_EVAL_MYSQL_URL='<owned-local-MySQL-base>' \
OPENWORK_WORKSHOP_REPORT_DIR='<fresh-private-Qwen-run-directory>' \
pnpm evals:e2e workshop-narrative --local --surface web --engine v1
```

The scoped world consumer retrieves only the selected OpenRouter credential from Infisical; no credential is embedded in this report or provided as an argument. This command has not run yet in this phase.

## Publication

The frozen red comparison remains at `69e44ec4a3`; no earlier record is rewritten. Drive is unavailable (no verified credentials). The normal protected CI route cannot currently import the local evidence while preserving the requested stacked PR base; no hosted screenshot URL, public attachment fallback, or manual-publisher authorization is claimed.
