import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

const captureSchema = z.object({
  format: z.literal('cdp-screencast'),
  startedAt: z.number().positive(), stoppedAt: z.number().positive(), clock: z.string(),
  frames: z.array(z.object({
    file: z.string().regex(/^frames\/\d+\.jpg$/), timestamp: z.number().positive(),
    receivedAt: z.number().positive(),
  })).min(2),
});

async function main() {
  const [sourceArg, outputArg] = process.argv.slice(2);
  if (!sourceArg || !outputArg || process.argv.length !== 4) throw new Error('Usage: node prepare-cdp.ts <finalized-film-directory> <new-output.mp4>');
  const source = await realpath(sourceArg);
  const output = resolve(outputArg);
  if (!output.endsWith('.mp4') || /['\r\n]/.test(source)) throw new Error('Expected safe local input path and MP4 output');
  await realpath(dirname(output));
  const raw = await readFile(join(source, 'capture.json'));
  const capture = captureSchema.parse(JSON.parse(raw.toString('utf8')));
  const first = capture.frames[0].timestamp;
  const end = capture.stoppedAt / 1000;
  if (end <= first || end - first > 180) throw new Error('Finalized screencast must span more than zero and at most 180 seconds');
  const lines = ['ffconcat version 1.0'];
  const sources = [];
  for (const [index, frame] of capture.frames.entries()) {
    const path = await realpath(join(source, frame.file));
    if (!path.startsWith(`${source}${sep}`)) throw new Error('Frame escapes supplied capture directory');
    const next = capture.frames[index + 1]?.timestamp ?? end;
    if (next < frame.timestamp || frame.timestamp < capture.startedAt / 1000) throw new Error('Non-monotonic capture timestamps');
    const bytes = await readFile(path);
    sources.push({ ...frame, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (next === frame.timestamp) continue;
    lines.push(`file '${path}'`, 'option framerate 1000', `duration ${next - frame.timestamp}`);
  }
  lines.push(`file '${join(source, capture.frames[capture.frames.length - 1].file)}'`, 'option framerate 1000');
  const concat = `${output}.ffconcat`;
  await writeFile(concat, `${lines.join('\n')}\n`, { flag: 'wx' });
  const result = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-safe', '0', '-f', 'concat', '-i', concat,
    '-t', String(end - first), '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
    '-an', '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-threads', '2', output], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('CDP video conversion failed; original capture unchanged');
  const receipt = { format: 'cdp-screencast-derived-mp4', captureSha256: createHash('sha256').update(raw).digest('hex'),
    startedAt: capture.startedAt, stoppedAt: capture.stoppedAt, firstFrameTimestamp: first,
    durationSeconds: end - first, clock: capture.clock,
    transformations: 'Original frame timestamps converted to 30 fps; original JPEG pixels retained, including baked dark sidebar; no audio.',
    outputSha256: createHash('sha256').update(await readFile(output)).digest('hex'), sources };
  await writeFile(`${output}.source.json`, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(`Prepared real CDP clip: ${output}; frames=${sources.length}; seconds=${end - first}`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'CDP preparation failed');
  process.exitCode = 1;
});
