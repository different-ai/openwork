# Connecting accounts in Workbot

Members connect their assigned apps from Workbot on cloud and self-hosted
deployments whenever `DEN_WORKBOT_URL` is configured. That URL fixes the only
allowed Workbot origin; no new provider credentials or product environment
switches are introduced.

Workbot posts a connection ID, a bounded path-only return, and a random attempt
ID to `/v1/workbot/connections/:connectionId/connect/start`. Den verifies the
OAuth grant, write scope, active membership, and the configured Workbot origin. It re-enters
the existing member connection start with an in-process signed principal. The
token's organization is authoritative: a browser header cannot select another
organization. Existing native-provider grants, external per-member grants, and
shared-credential management permissions remain in force.

The existing OAuth state signs the member, organization, connection binding,
expiry, attempt ID, Workbot origin, and return path. Existing provider callback,
PKCE, issuer, and credential-persistence validation remains in place. Changing
the configured origin prevents a previously signed return from being used.

The signed Workbot completion page reports sign-in, not a ready connection,
and offers a return to the original Workbot view for verification. Its failure
copy gives a safe retry/admin action without rendering provider error prose.
Ordinary non-Workbot completion pages keep their existing behavior. Only the
Workbot variant uses the compact shared typography scale (20px heading, 13px
body) and spacing tokens, including on narrow screens.

If Workbot cannot identify a matching account, including with older Den metadata,
it offers “Open connection settings”, not a Connect action or a claim that a
grant is absent. Known connection-specific legacy links retain their flow.

Completion sends only a finite outcome, attempt ID, and connection ID to the
exact Workbot origin. Workbot accepts it only from the window it opened, at the
expected callback origin, for its current attempt. A message never marks an
account connected: Den's fresh connection readiness and resource reads must
confirm access. Denial, expiry, missing scopes, and incomplete admin setup stay
recoverable without exposing provider errors or tokens to chat.

Unsaved document recovery is owned by the shared Documents browser, not by
OAuth completion. Each file's scoped, memory-only lock lasts at most 15 minutes,
without extending on retry. Reconnect appears inside that locked state. Even
after fresh Den readiness and a successful directory read, explicit **Check access
and restore tabs** or an individual file's **Check access** must verify matching
identity and that file's authorization before revealing its retained work.
Authorized files can return independently; denied files stay masked, retryable
and individually discardable. Denied consent does not discard drafts, and
restoration never replays a save. The parent identity owner and its portals remain
mounted but masked from the start of revalidation, including while a response is
pending. Cached identity success is not current authorization. Explicit file checks
resume only after the matching fresh identity has committed to the UI's authorization
policy; the separate sign-in recovery link is unchanged.

A blocked popup offers an explicit same-tab action. A callback without an opener
offers a return link to the signed Workbot path. When no Workbot origin is
configured, the existing specific-connection Den link remains available, honestly labelled
“Finish in the new tab”, with readiness auto-detection. No migration, rollout,
or provider setup is performed by this change.

Verification: `workbot-connect.api.test.ts` covers authorization and isolation;
`workbot-connect.proof.test.ts` drives the real UI and Den callbacks against a
localhost fake provider and a disposable MySQL database. It does not prove live
provider configuration or deployment readiness.
