import { detachDevHeadless, main } from "../worlds/dev-headless.ts";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  await (argv.includes("--detach")
    ? detachDevHeadless(argv.filter((argument) => argument !== "--detach"))
    : main(argv));
}
