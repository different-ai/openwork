import { fileURLToPath } from "node:url";
import { main as runWorldCli, parseWorldArgs } from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WORLDS_DIRECTORY = fileURLToPath(new URL("../../../../worlds", import.meta.url));

export { parseWorldArgs };

export function main(argv = process.argv.slice(2)): Promise<number> {
  return runWorldCli(argv, {
    cwd: REPO_ROOT,
    worldsDirectory: WORLDS_DIRECTORY,
  });
}
