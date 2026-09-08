import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const coworkerRoot = path.resolve(scriptDir, "..");
const source = path.join(coworkerRoot, "resources", "installer", "dmg-background.svg");

if (process.platform !== "darwin") {
  throw new Error("The macOS installer background requires the macOS sips renderer.");
}

const scratch = await mkdtemp(path.join(tmpdir(), "coworker-installer-"));
try {
  const [whiteMark, officeIllustration, sourceSvg] = await Promise.all([
    readFile(path.join(coworkerRoot, "public", "open-coworker.svg")),
    readFile(path.join(coworkerRoot, "resources", "installer", "office-activity-outline.png")),
    readFile(source, "utf8"),
  ]);
  // Embed the canonical mark and office artwork for sips, whose temporary SVG
  // has no access to the source file's relative image paths.
  const svg = sourceSvg.replaceAll(
    "../../public/open-coworker.svg", `data:image/svg+xml;base64,${whiteMark.toString("base64")}`,
  ).replaceAll("office-activity-outline.png", `data:image/png;base64,${officeIllustration.toString("base64")}`);
  // Render both densities from vector source; enlarging the PNG blurs small text.
  // electron-builder combines these siblings into a multi-resolution TIFF.
  for (const scale of [1, 2]) {
    const width = 760 * scale;
    const height = 600 * scale;
    const scaledSource = path.join(scratch, `background-${scale}.svg`);
    const output = path.join(coworkerRoot, "resources", "installer", `dmg-background${scale === 2 ? "@2x" : ""}.png`);
    await writeFile(scaledSource, svg.replace('width="760" height="600"', `width="${width}" height="${height}"`));
    await execFileAsync("sips", ["-s", "format", "png", scaledSource, "--out", output]);
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", output]);
    if (!stdout.includes(`pixelWidth: ${width}`) || !stdout.includes(`pixelHeight: ${height}`)) {
      throw new Error(`Unexpected installer background dimensions:\n${stdout}`);
    }
    console.log(`Rendered ${path.relative(coworkerRoot, output)} at ${width}x${height}.`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
