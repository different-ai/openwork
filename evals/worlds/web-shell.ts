import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { bootDevHeadless } from "./infra.ts";

export async function webSearchBar(_seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  const headless = await bootDevHeadless(stack, {
    name: `web-search-bar-${process.pid}`,
    replace: true,
  });
  const web = stack.use(await chrome({
    name: "web-search-bar",
    host: place.host(),
    startUrl: headless.manifest.webUrl,
    headless: true,
  }));
  return { web, headless, [Symbol.asyncDispose]: () => stack.disposeAsync() };
}
