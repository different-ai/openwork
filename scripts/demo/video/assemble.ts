import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { journeyBuildKind, manifestSchema, matchesVideoFormat, releaseReceiptSchema, videoFormat } from './manifest.ts';
import type { RenderScene } from './manifest.ts';
import { validateCompletion, verifyCompletedMedia } from './completion.ts';

const root = dirname(fileURLToPath(import.meta.url));
const reports = resolve(root, '../../../reports/demo');
const outputRoot = join(reports, 'eng-105-2026-09-15');
const args = process.argv.slice(2);
const captureRoot = resolve(process.env.ENG105_CAPTURE_ROOT ?? join(reports, 'eng105-proof'));
const probeSchema = z.object({
  streams: z.array(z.object({
    codec_name: z.string(),
    width: z.number().positive(),
    height: z.number().positive(),
    avg_frame_rate: z.string().optional(),
  })).min(1),
  format: z.object({ duration: z.string().optional() }),
});

function run(command: string, argv: string[]) {
  const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; check installation and media integrity`);
  return result.stdout;
}

function probe(path: string) {
  return probeSchema.parse(JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', path])));
}

async function hash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function localFile(base: string, path: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error('Only local media/evidence paths are accepted');
  const resolved = await realpath(resolve(base, path));
  if (!(await stat(resolved)).isFile()) throw new Error('Media/evidence must be a real local file');
  return resolved;
}

async function main() {
  if (args.length === 1 && args[0] === '--help') {
    console.log('pnpm assemble --manifest <sanitized.json> [--validate-only]\nSet progress explicitly to partial or complete. Complete requires completion {runId, runName, runnerReceiptPath, claimsReceiptPath, bindingReceiptPath}: finalized C test-run.json, all canonical ten Passed claims, and owner binding with exit0/1 passed/0 failed/0 skipped, matching run/gitSHA/file hashes and approved media hashes. No complete mode from subset scenes. Each present C/D lane must contain A and B. C accepts clip/png; D accepts png only. Media must be under reports/demo/eng105-proof, or the explicitly authorized ENG105_CAPTURE_ROOT. Every scene requires release {buildKind, desktopVersion, desktopTag, releaseSha, lane, denBuildIdentity, evidencePath}. The local JSON receipt must contain those identity fields plus member (no evidencePath), matching exactly. buildKind is release-source, packaged-release, or development. release-source pins v0.18.46/a0d6bd1de8debf4f09d22b8538e124b2ff45b339 and is explicitly not a packaged binary. Outputs stay in ignored reports/demo/eng-105-2026-09-15/runs/. No export. See manifest.template.json; replace placeholders and attest actualCapture/sanitized only after review. Requires ffmpeg and ffprobe on PATH.');
    return;
  }
  if (args[0] !== '--manifest' || !args[1] || args.length > 3 || (args[2] && args[2] !== '--validate-only')) {
    throw new Error('Usage: pnpm assemble --manifest <sanitized.json> [--validate-only]');
  }
  if (await realpath(process.cwd()) !== await realpath(root)) throw new Error('Run from scripts/demo/video');
  run('ffmpeg', ['-version']);
  run('ffprobe', ['-version']);
  const input = await localFile(root, args[1]);
  if ((await stat(input)).size > 262144) throw new Error('Manifest exceeds 256 KiB');
  const source = await readFile(input, 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(source));
  let completionEvidence: ReturnType<typeof validateCompletion> | undefined;
  let completionHashes: { runnerSha256: string; claimsSha256: string; bindingSha256: string } | undefined;
  if (manifest.progress === 'complete') {
    const config = manifest.completion;
    if (!config) throw new Error('Complete mode requires finalized C evidence');
    const runnerPath = await localFile(dirname(input), config.runnerReceiptPath);
    if (basename(runnerPath) !== 'test-run.json') throw new Error('Use the canonical finalized C test-run.json');
    const claimsPath = await localFile(dirname(input), config.claimsReceiptPath);
    const bindingPath = await localFile(dirname(input), config.bindingReceiptPath);
    for (const path of [runnerPath, claimsPath, bindingPath]) {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Completion evidence exceeds 32 MiB');
    }
    completionHashes = { runnerSha256: await hash(runnerPath), claimsSha256: await hash(claimsPath), bindingSha256: await hash(bindingPath) };
    completionEvidence = validateCompletion({
      runner: JSON.parse(await readFile(runnerPath, 'utf8')), claims: JSON.parse(await readFile(claimsPath, 'utf8')),
      binding: JSON.parse(await readFile(bindingPath, 'utf8')), ...completionHashes, runId: config.runId, runName: config.runName,
    });
  }
  const allowedCaptureRoot = await realpath(captureRoot);
  const checked = [];
  for (const [index, scene] of manifest.scenes.entries()) {
    const releaseEvidence = await localFile(dirname(input), scene.release.evidencePath);
    if ((await stat(releaseEvidence)).size > 65536) throw new Error('Release receipt exceeds 64 KiB');
    const releaseSource = await readFile(releaseEvidence, 'utf8');
    const releaseReceipt = releaseReceiptSchema.parse(JSON.parse(releaseSource));
    if (releaseReceipt.member !== scene.member
      || releaseReceipt.desktopVersion !== scene.release.desktopVersion
      || releaseReceipt.desktopTag !== scene.release.desktopTag
      || releaseReceipt.denBuildIdentity !== scene.release.denBuildIdentity
      || releaseReceipt.buildKind !== scene.release.buildKind
      || releaseReceipt.releaseSha !== scene.release.releaseSha
      || releaseReceipt.lane !== scene.release.lane) {
      throw new Error(`Scene ${index + 1}: release receipt does not match member and actual build identity`);
    }
    const releaseEvidenceSha256 = createHash('sha256').update(releaseSource).digest('hex');
    const path = await localFile(dirname(input), scene.path);
    if (!path.startsWith(`${allowedCaptureRoot}${sep}`)) {
      throw new Error('Media must come from the authorized read-only capture export directory');
    }
    const media = probe(path);
    const frames = Math.round(scene.durationSeconds * 30);
    const duration = frames / 30;
    if (scene.kind === 'png' && media.streams[0].codec_name !== 'png') throw new Error(`Scene ${index + 1}: expected a real PNG`);
    if (scene.kind === 'clip') {
      const available = Number(media.format.duration);
      if (!Number.isFinite(available) || available < scene.startSeconds + duration) {
        throw new Error(`Scene ${index + 1}: clip is missing sufficient real footage`);
      }
    }
    const evidence = scene.assertion.evidencePath
      ? await localFile(dirname(input), scene.assertion.evidencePath) : undefined;
    if (evidence && !(await stat(evidence)).size) throw new Error('Assertion evidence file is empty');
    const sourceSha256 = await hash(path);
    if (completionEvidence && completionHashes) {
      const { claims, binding } = completionEvidence;
      if (scene.release.buildKind !== claims.buildKind || scene.release.desktopVersion !== claims.desktopVersion
        || scene.release.desktopTag !== claims.desktopTag || scene.release.releaseSha !== claims.releaseSha
        || scene.release.lane !== claims.lane || scene.release.denBuildIdentity !== claims.denBuildIdentity) {
        throw new Error('Scene release provenance does not match the finalized C claims run');
      }
      if (!evidence || ![completionHashes.runnerSha256, completionHashes.claimsSha256].includes(await hash(evidence))) {
        throw new Error('Complete scene assertions must reference the exact finalized C runner or claims receipt');
      }
      let derivedReceipt: unknown;
      if (scene.kind === 'clip') {
        if (!scene.captureReceiptPath) throw new Error('Complete CDP clip requires its source hash-chain receipt');
        const capturePath = await localFile(dirname(input), scene.captureReceiptPath);
        if ((await stat(capturePath)).size > 8 * 1024 * 1024) throw new Error('Capture receipt exceeds 8 MiB');
        derivedReceipt = JSON.parse(await readFile(capturePath, 'utf8'));
      }
      verifyCompletedMedia(binding, { kind: scene.kind, sha256: sourceSha256, derivedReceipt });
    }
    checked.push({ scene, path, frames, releaseEvidenceSha256, sourceId: `source-${index + 1}`, sha256: sourceSha256,
      evidenceSha256: evidence ? await hash(evidence) : null });
  }
  if (args[2] === '--validate-only') {
    console.log(`Validated ${checked.length} supplied media entries; no render or test verdict. Capture authenticity/redaction remain operator-attested.`);
    return;
  }
  await mkdir(join(outputRoot, 'runs'), { recursive: true });
  const work = await mkdtemp(join(outputRoot, 'runs', 'assembly-'));
  const assets = join(work, 'public');
  await mkdir(assets);
  await mkdir(join(work, 'tmp'));
  process.env.TMPDIR = join(work, 'tmp');
  const scenes: RenderScene[] = [];
  const receipts = [];
  for (const item of checked) {
    const { scene, sourceId, path, frames } = item;
    const original = join(assets, `${sourceId}-original.${scene.kind === 'png' ? 'png' : 'media'}`);
    await copyFile(path, original);
    if (await hash(original) !== item.sha256) throw new Error('Source changed during preparation; refusing inconsistent output');
    const asset = `${sourceId}.${scene.kind === 'png' ? 'png' : 'mp4'}`;
    const normalized = join(assets, asset);
    if (scene.kind === 'png') await copyFile(original, normalized);
    else run('ffmpeg', ['-v', 'error', '-nostdin', '-i', original, '-ss', String(scene.startSeconds), '-t', String(frames / 30),
      '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
      '-frames:v', String(frames), '-c:v', 'libx264', '-threads', '1', '-crf', '18', '-pix_fmt', 'yuv420p', normalized]);
    const renderScene: RenderScene = { variant: scene.variant, member: scene.member, kind: scene.kind,
      actualCapture: true, durationSeconds: frames / 30, startSeconds: 0, caption: scene.caption, observed: scene.observed,
      hiddenApiSetup: scene.hiddenApiSetup, assertion: { state: scene.assertion.state }, asset, frames,
      release: { desktopVersion: scene.release.desktopVersion, desktopTag: scene.release.desktopTag,
        denBuildIdentity: scene.release.denBuildIdentity, buildKind: scene.release.buildKind,
        releaseSha: scene.release.releaseSha, lane: scene.release.lane } };
    scenes.push(renderScene);
    receipts.push({ ...renderScene, sourceId, sourceSha256: item.sha256, sourceStartSeconds: scene.startSeconds,
      assetSha256: await hash(normalized), evidenceSha256: item.evidenceSha256,
      releaseEvidenceSha256: item.releaseEvidenceSha256 });
  }
  const receipt = { version: 1, status: 'prepared-not-rendered', progress: manifest.progress, ...videoFormat,
    completion: completionEvidence ? { runId: completionEvidence.binding.runId, runName: completionEvidence.runner.name,
      closedAt: completionEvidence.runner.closedAt, gitSha: completionEvidence.runner.gitSha,
      outcome: completionEvidence.runner.outcome, claimIds: completionEvidence.claims.claims.map((claim) => claim.claim),
      ...completionHashes } : null,
    inputManifestSha256: createHash('sha256').update(source).digest('hex'),
    provenance: 'Operator-attested actual captures and sanitization. Assembler does not verify test assertions or detect secrets in pixels.',
    scenes: receipts };
  const receiptPath = join(work, 'manifest.sanitized.json');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await bundle({ entryPoint: join(root, 'video.tsx'), publicDir: assets, outDir: join(work, 'bundle') });
  const outputs = [];
  for (const variant of ['C', 'D']) {
    const selected = scenes.filter((scene) => scene.variant === variant);
    if (!selected.length) continue;
    const inputProps = { scenes: selected, progress: manifest.progress };
    const composition = await selectComposition({ serveUrl, id: 'ENG105', inputProps });
    const journey = journeyBuildKind(selected.map((scene) => scene.release));
    const file = `ENG105-${variant}-${journey}-${manifest.progress.toUpperCase()}.mp4`;
    const output = join(work, file);
    await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', outputLocation: output,
      pixelFormat: 'yuv420p', crf: 18, concurrency: 1, muted: true, overwrite: false });
    const rendered = probe(output);
    const seconds = Number(rendered.format.duration);
    const expected = selected.reduce((sum, scene) => sum + scene.frames, 0) / 30;
    if (!Number.isFinite(seconds) || seconds > 180 || Math.abs(seconds - expected) > 0.05
      || !matchesVideoFormat(rendered.streams[0].width, rendered.streams[0].height, rendered.streams[0].avg_frame_rate)) throw new Error('Output duration/geometry/fps validation failed');
    outputs.push({ variant, journey, file, durationSeconds: seconds, sha256: await hash(output) });
    await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'partial-render-no-test-verdict', outputs }, null, 2));
  }
  await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'rendered-no-test-verdict', outputs }, null, 2));
  console.log(`Local assembly: ${work}\nSanitized receipt: ${receiptPath}\nNo export/upload. Render completion is not passing test evidence.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join('\n')
    : error instanceof Error ? error.message : 'Assembly failed');
  process.exitCode = 1;
});
