# White-label rollout and rollback

White-label appearance remains implemented behind the permanent `whiteLabel` feature flag. All runtime decisions use the central feature registry/resolver.

## Defaults and existing customers

| Deployment / organization | Default |
| --- | --- |
| Self-hosted | On |
| New Cloud organizations | Off |
| Cloud organizations already using branding | On through a stored organization override |

Cloud startup performs a one-time cutover **before serving requests or starting workers**. The initializer atomically creates the deployment's `whiteLabel` rollout row and inserts missing organization overrides for historical branding users. Detection includes nonempty saved brand fields/asset references and legacy organization logos used by installation identity.

This detection is only a backfill, never runtime feature authority. Explicit organization overrides and preconfigured deployment policies are not overwritten. Later startups do not re-enable cleared overrides or promote organizations by reading newly added metadata. A restored or already configured deployment uses its stored policy as-is.

The existing Enterprise entitlement and permissions remain required for branding changes. Existing licensing agreements are unchanged.

## Controls

- Platform administrators use `/admin` for deployment state, organization overrides, and the kill switch.
- Self-hosted operators can use the generated Helm `config.features.whiteLabel` lock.
- The normal precedence remains: availability → kill switch → operator lock → organization override → everyone/default.
- Use these controls rather than deleting rollout rows: the initial Cloud rollout row also records that grandfathering has completed.

## Safe to turn off

OFF projects stock OpenWork identity and blocks branding mutations without deleting the original organization metadata, uploaded asset bytes, desktop bootstrap values, or cached icon sources. Brand appearance remains visible as a locked entry point. ON restores normal branding behavior.

Install/connect payloads remain valid for older desktops: custom values when enabled, stock values when disabled, and an explicit `whiteLabelEnabled` projection for updated clients. Signature verification, issuer binding, HTTPS checks, expiry, and one-use exchange protection remain intact.

Updated desktops preserve and target-scope local rollback data before organization/control-plane switches. Shell-issued snapshot receipts protect transaction rollback. Appearance persistence is serialized and bound to the originating refresh, Den/API target, organization, and session; delayed ON responses cannot override newer OFF decisions or enrollment changes. Confirmed organization switches retire stale prepared/handoff records from the live bootstrap while retaining their rollback snapshots. One-time grant cleanup removes only the matching grant from the latest queued enrollment; it never reapplies an older enrollment snapshot. Onboarding waits for the same guarded appearance reconciliation rather than persisting its own captured branding response.

If renderer rollback storage is unavailable, appearance-only OFF can still be persisted without changing source branding or enrollment. Destructive replacements, target switches, and snapshot restores still require successful preservation. See the [desktop rollback storage contract](../apps/desktop/electron/desktop-brand-rollback.md).

No database schema migration or destructive cleanup is included. Grandfathering writes only the existing feature-control tables.

## Rollout and verification

Upgrade the Den control plane and desktop clients together; updated clients default to stock when an older server does not report the new flag. Back up manual/MDM bootstrap sources before mixed-version deployment, since older binaries retain their own local write/cleanup logic.

`evals/specs/white-label-rollout.test.ts` proves self-hosted ON, new Cloud OFF, automatic grandfathering through real server startup, explicit OFF/cleared override preservation, kill precedence, and unchanged stored branding/asset bytes across off/on changes. `evals/specs/desktop-connect-rollback.test.ts` exercises real Den handoffs with the frozen pre-flag desktop verifier and the current verifier.

Native Windows Explorer/Dock and packaged mixed-version UI smoke tests remain separate verification work; protocol/storage tests are not a claim that those have run.
