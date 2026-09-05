import { defaultWorldCliPaths, main } from "./cli.ts";

/** Standalone script-world CLI. */
export function runStandaloneWorldCli(
  argv: string[] = process.argv.slice(2),
  cwdInput: string = process.cwd(),
): Promise<number> {
  return main(argv, defaultWorldCliPaths(cwdInput));
}
