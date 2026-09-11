# Gateway Credential Set Creator

Additive successor to registered `0098_gateway_provider_model_universe`.
The nullable `gateway_credential_sets.created_by_org_membership_id` records
the membership that creates a new set. Existing rows remain NULL (unknown);
there is no provider-owner backfill, foreign key, or historical name rewrite.
Deleting a member does not erase an already recorded creator ID.

Offline metadata generation uses the actual Drizzle serializer against current
source and the 0098 snapshot, accepting only this one nullable column:

```sh
pnpm --dir ee/packages/den-db exec node --conditions=development --import tsx scripts/generate-gateway-set-creator-metadata.mjs
```

The generator registers 0099 in the journal and writes a version-5 snapshot
linked to 0098. It refuses unrelated schema/SQL drift or a different journal tip.
Existing JSON defaults and migration-matcher normalization are unchanged.
The existing local-startup migration runner reads this registered SQL normally;
no migration, database connection, build, or service restart is performed here.

## Deferred Regression Coverage

No tests are authored or executed in this source-only batch. Follow-up runtime
coverage should assert:

- Existing sets report their original creation date and a null creator.
- New sets record the live same-organization route actor, including nested
  creation and an administrator converting another member's LLM provider.
- Missing, removed, unlinked, and cross-organization actors cannot create sets.
- Renames, credential replacement, mode changes, and disable/re-enable retain
  the original creator and creation date.
- Removed/missing creator displays retain the recorded membership ID with null
  name/email; another organization's user display is never joined.
- Management responses include creator/date without credential secrets; usable
  lists, connect payloads, and model configs omit creator metadata and stored
  provider secrets (connect still returns the caller's own Gateway bearer key).
- Successful provider creation seeds `all allowed models`, including an empty
  universe without initial grants. Explicit empty membership grants no models.
- Refresh/shrink preserves the group while pruning obsolete model links; growth
  does not add links. An explicitly deleted group is not recreated by reads,
  catalog refreshes, or edits. Historical group names remain unchanged.
