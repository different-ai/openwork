import { z } from 'zod';

// Canonical C checklist, supplied by the proof owner; selected video scenes cannot shrink it.
export const requiredClaims = [
  'Den Add, auto-run, named sharing, both Home/Clocks desktops',
  'Alex personal OAuth through Your Connections',
  'Calendar added through Den UI with default arguments',
  'Jordan personal OAuth through separate Your Connections',
  'Alex real Calendar renders personal identity and meetings',
  'Jordan real shared Calendar renders personal identity and meetings',
  'Calendar member identities and meeting sets are different',
  'alex Calendar Refresh makes a new default tool invocation',
  'jordan Calendar Refresh makes a new default tool invocation',
  'World Clocks edit, native save confirmation, and fresh-tool persistence',
];

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const runnerSchema = z.object({
  name: z.string().min(1), dir: z.string().min(1), gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  createdAt: z.iso.datetime(), closedAt: z.iso.datetime(), outcome: z.literal('passed'),
  summary: z.object({
    // Testkit includes supplementary captures in summary.ok, not only assertions.
    // A false summary is accepted below only when exactly explained by unjudged captures.
    ok: z.boolean(), totalArtifacts: z.number().int().positive(), unvalidatedArtifacts: z.number().int().nonnegative(),
    failedArtifacts: z.literal(0), failedExpectations: z.literal(0),
    pendingArtifacts: z.literal(0), pendingJudgments: z.literal(0), passedExpectations: z.number().int().positive(),
  }).passthrough(),
  steps: z.array(z.object({ name: z.string(), ok: z.literal(true) }).passthrough()),
  artifacts: z.array(z.object({
    ok: z.union([z.literal(true), z.null()]),
    results: z.array(z.object({ passed: z.literal(true) }).passthrough()),
    judgments: z.array(z.object({ state: z.literal('passed') }).passthrough()),
  }).passthrough()),
}).passthrough().refine((run) => Date.parse(run.closedAt) >= Date.parse(run.createdAt), 'C runner is not finalized')
  .refine((run) => {
    const supplementary = run.artifacts.filter((artifact) => artifact.ok === null);
    return supplementary.every((artifact) => artifact.results.length === 0 && artifact.judgments.length === 0)
      && run.summary.totalArtifacts === run.artifacts.length
      && run.summary.unvalidatedArtifacts === supplementary.length
      && run.summary.ok === (supplementary.length === 0)
      && run.summary.passedExpectations === run.artifacts.reduce((count, artifact) => count + artifact.results.length, 0);
  }, 'Runner summary must exactly match passing assertions and supplementary unjudged captures');

const claimsSchema = z.object({
  buildKind: z.enum(['release-source', 'packaged-release']),
  desktopVersion: z.string().min(1), desktopTag: z.string().min(1),
  releaseSha: z.string().regex(/^[a-f0-9]{40}$/), overlaySha: z.string().regex(/^[a-f0-9]{40}$/), lane: z.string().min(1), denBuildIdentity: z.string().min(1),
  claims: z.array(z.object({ claim: z.string().min(1), status: z.literal('Passed'), detail: z.string().trim().min(1) }).strict()),
}).passthrough().superRefine((receipt, ctx) => {
  const ids = receipt.claims.map((claim) => claim.claim);
  if (ids.length !== requiredClaims.length || new Set(ids).size !== ids.length
    || requiredClaims.some((id) => !ids.includes(id)) || ids.some((id) => !requiredClaims.includes(id))) {
    ctx.addIssue({ code: 'custom', message: 'Complete requires the exact canonical ten C claims, each Passed exactly once; subset scenes are insufficient' });
  }
});

export const completionBindingSchema = z.object({
  finalized: z.literal(true),
  runId: z.string().min(1), runName: z.string().min(1),
  gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  exitCode: z.literal(0), passedTests: z.literal(1), failedTests: z.literal(0), skippedTests: z.literal(0),
  runnerSha256: sha256, claimsSha256: sha256,
  media: z.array(z.object({ kind: z.enum(['png', 'cdp-capture']), sha256 }).strict()).min(2),
}).strict();

export function validateCompletion(input: {
  runner: unknown; claims: unknown; binding: unknown;
  runnerSha256: string; claimsSha256: string; runId: string; runName: string;
}) {
  const runner = runnerSchema.parse(input.runner);
  const claims = claimsSchema.parse(input.claims);
  const binding = completionBindingSchema.parse(input.binding);
  if (runner.name !== input.runName || binding.runName !== runner.name || binding.runId !== input.runId
    || runner.dir.split(/[\\/]/).at(-1) !== input.runId
    || binding.gitSha !== runner.gitSha || claims.overlaySha !== runner.gitSha
    || binding.runnerSha256 !== input.runnerSha256 || binding.claimsSha256 !== input.claimsSha256) {
    throw new Error('Finalized C run/name and exact runner/claims hashes must match the owner binding');
  }
  return { runner, claims, binding };
}

const derivedCaptureSchema = z.object({
  format: z.literal('cdp-screencast-derived-mp4'),
  captureSha256: sha256, outputSha256: sha256,
}).passthrough();

export function verifyCompletedMedia(
  binding: z.infer<typeof completionBindingSchema>,
  media: { kind: 'png' | 'clip'; sha256: string; derivedReceipt?: unknown },
) {
  if (media.kind === 'png') {
    if (!binding.media.some((entry) => entry.kind === 'png' && entry.sha256 === media.sha256)) {
      throw new Error('PNG is not bound to the finalized passing C run; old partial media is not complete evidence');
    }
    return;
  }
  const derived = derivedCaptureSchema.parse(media.derivedReceipt);
  if (derived.outputSha256 !== media.sha256
    || !binding.media.some((entry) => entry.kind === 'cdp-capture' && entry.sha256 === derived.captureSha256)) {
    throw new Error('Derived clip does not match the approved finalized C capture and output hashes');
  }
}
