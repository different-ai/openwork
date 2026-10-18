# Native Cloud skill instruction snapshots

The existing `nativeCloudSkills` rollout is off by default on cloud and
self-hosted deployments. No deployment setting or live rollout is changed by
this implementation.

## Registry versus instructions

The native registry contains bounded discovery/setup metadata only, including
full descriptions in native mode. It never stores a private SKILL.md body.
Unselected skills retrieve current instructions through OpenWork Connect
`get_skill`.

When a person selects or names a Cloud skill, the prompt hook:

1. Resolves a loadable catalog entry with an ID, capability, URL and SHA-256
   digest. A setup entry or missing digest is not ready.
2. Reads only selected bodies, freshly for this admission, with at most two
   reads running per location. Earlier bodies and in-flight reads are not reused
   as access grants. Ordinary chat does not wait for discovery or hydration.
3. Verifies the body digest, then invokes the existing engine permission-create
   operation. The host checks the exact loadable identity before and after the
   permission operation, including its policy hooks. These authorization reads
   bypass the short discovery cache, so cached readiness or rollout decisions
   cannot become reusable grants.
4. Removes Cloud IDs from the prompt's mutable skill references and appends
   frozen inline text attachments containing the authorized bytes. Local skill
   references and existing user files remain unchanged.

OpenCode 2.0.26 resolves skill IDs after prompt hooks and asynchronous file
preparation. A final registry check alone cannot pin that later lookup. Its
existing inline text attachment primitive instead persists and sends the
prepared bytes, so a later registry refresh cannot substitute another body.
No version aliases, synthetic skill events, local SKILL.md writes or private
engine-service patches are used.

## Persisted provenance

The native user payload has `metadata.openworkCloudSkills` entries:

```ts
{
  id: string;
  capability: string;
  url: string;
  digest: string; // SHA-256 of authorized raw SKILL.md
  name: string;
  fileName: string;
  fileIndex: number;
  attachmentDigest: string; // SHA-256 of the persisted carrier bytes
}
```

The matching native `files` entry is `text/plain`, has an inline source and
base64 `data`. Its decoded carrier is exactly `# Skill instructions\n\n`
followed by the authorized SKILL.md. The fixed text heading prevents content
sniffing from treating Markdown containing SVG or HTML as media. Both raw and
carrier digests are verified. Inspection/rendering should identify the matching
file by index/name and carrier digest, not mistake registry discovery notes for
loaded instructions. Caller-supplied provenance is removed before this hook
mints verified entries.

## Off, unavailable and denied

Off-rollout metadata is not a ready explicit attachment. A denied, unapproved,
missing, withheld, changed or unreadable skill stops native admission without
adding instruction bytes. Killing the rollout blocks new authorizations; it
does not alter existing conversation history. On the pinned engine, rejecting a
prompt hook returns a generic HTTP 500 because it has no typed rejection API.

`apps/server/test/openwork-cloud-skills-native.test.ts` verifies this against
the pinned native binary and a loopback-only model, including warm setup/digest
changes, real policy decisions, actual model receipt, persisted carrier hashes,
and registry mutation both during authorization and after the prompt hook.
