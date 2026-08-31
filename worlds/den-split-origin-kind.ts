import { kindServer } from "../evals/packages/env/src/kind-server.ts";
import { hold } from "../packages/world/src/hold.ts";

/**
 * The Kind Helm fixture has separate browser-facing web/API origins while
 * DEN_API_BASE remains the in-cluster service.
 */
export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const den = stack.use(await kindServer());
  await hold({
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
    },
  });
}

if (import.meta.main) {
  await main();
}
