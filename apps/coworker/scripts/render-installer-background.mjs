import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const coworkerRoot = path.resolve(scriptDir, "..");
const source = path.join(coworkerRoot, "resources", "installer", "dmg-background.svg");
const output = path.join(coworkerRoot, "resources", "installer", "dmg-background.png");

if (process.platform !== "darwin") {
  throw new Error("The macOS installer background requires the macOS sips renderer.");
}

await execFileAsync("sips", ["-s", "format", "png", source, "--out", output]);
const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", output]);

if (!stdout.includes("pixelWidth: 760") || !stdout.includes("pixelHeight: 500")) {
  throw new Error(`Unexpected installer background dimensions:\n${stdout}`);
}

console.log(`Rendered ${path.relative(coworkerRoot, output)} at 760x500.`);
