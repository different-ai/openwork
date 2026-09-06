import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordingFromCapture } from "@openwork/presentation/recording";

const [directory, ...flags] = process.argv.slice(2);
if (!directory || flags.some((flag) => !/^--still=\d+$/.test(flag))) {
  throw new Error(
    "Usage: pnpm --dir scenarios onboarding:render <capture-directory> [--still=frame]",
  );
}
const captureDirectory = resolve(directory);
const recording = recordingFromCapture(
  JSON.parse(await readFile(join(captureDirectory, "capture.json"), "utf8")),
);
const completed = recording.downloads.find(
  (event) => event.state === "completed",
);
if (
  !completed ||
  completed.receivedBytes <= 0 ||
  completed.receivedBytes !== completed.totalBytes ||
  recording.downloads.some((event) => event.state === "canceled")
) {
  throw new Error(
    "Onboarding needs a completed installer download before animating the app opening",
  );
}
const temporary = await mkdtemp(join(tmpdir(), "openwork-onboarding-render-"));
try {
  const publicDir = join(temporary, "public");
  await mkdir(publicDir);
  await cp(join(captureDirectory, "frames"), join(publicDir, "frames"), {
    recursive: true,
  });
  const serveUrl = await bundle({
    entryPoint: join(dirname(fileURLToPath(import.meta.url)), "remotion.tsx"),
    outDir: join(temporary, "bundle"),
    publicDir,
  });
  const inputProps = { recording };
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
  const composition = await selectComposition({
    serveUrl,
    id: "Onboarding",
    inputProps,
    browserExecutable,
  });
  const still = flags.find((flag) => flag.startsWith("--still="));
  if (still) {
    const frame = Number(still.slice(8));
    const output = join(captureDirectory, `preview-${frame}.png`);
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      browserExecutable,
      frame,
      output,
    });
    console.log(output);
  } else {
    const outputLocation = join(captureDirectory, "onboarding.mp4");
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      browserExecutable,
      codec: "h264",
      outputLocation,
      concurrency: 2,
      crf: 18,
    });
    console.log(outputLocation);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
