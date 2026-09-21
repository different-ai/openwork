import { server } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { secret } from "../packages/world/src/outputs.ts";

/** Disposable local Den for the uncommitted Code Mode worktree. */
export async function main(): Promise<void> {
  const place = resolvePlace();
  if (place.kind !== "local") throw new Error("This working-tree preview requires --place local.");
  await using stack = new AsyncDisposableStack();
  const den = stack.use(await server({
    place, web: true,
    org: { name: "Code Mode preview", admin: { name: "Preview owner", email: "owner@codemode.example.test" } },
    env: { OPENWORK_DEV_MODE: "1", DEN_REQUIRE_EMAIL_VERIFICATION: "false", RESEND_API_KEY: "", SMTP_HOST: "", DEN_CODE_MODE_OPT_IN_ENABLED: "true" },
  }));
  await hold({ name: "code-mode-preview", outputs: {
    denWeb: den.ref.webUrl, denApi: den.ref.apiUrl,
    email: den.admin.email, password: secret(den.admin.password),
  } });
}

if (import.meta.main) await main();
