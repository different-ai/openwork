import { allocateFreePorts } from "@openwork/cdp";
import type { AppWeb, Den, SeedAppWebOptions, Seed, ServerOptions } from "@openwork/env";

/**
 * A Den that trusts one app-in-a-browser origin, plus that origin's port.
 * Pass the port to `signedInAppWeb` so the browser app is served from it.
 */
export async function denForAppWeb(seed: Seed, options: Omit<ServerOptions, "place"> = {}): Promise<{ den: Den; webPort: number }> {
  const [webPort] = await allocateFreePorts(1);
  if (!webPort) throw new Error("No port available for the app in a browser.");
  const den = await seed.den({
    ...options,
    trustedOrigins: [...(options.trustedOrigins ?? []), `http://127.0.0.1:${webPort}`],
  });
  return { den, webPort };
}

export interface SignedInAppWebOptions extends Omit<SeedAppWebOptions, "den" | "webPort"> {
  den: Den;
  webPort: number;
  /** "admin" or a key of `den.members`. */
  as?: string;
}

/**
 * The real app in headless Chrome, signed in to Den as one person, with its
 * workspace selected. This is the browser counterpart of
 * `seed.desktop({ den, as })`.
 */
export async function signedInAppWeb(seed: Seed, options: SignedInAppWebOptions): Promise<{ app: AppWeb; workspace: { workspaceId: string; route: string } }> {
  const { den, webPort, as = "admin", ...appOptions } = options;
  const member = as === "admin" ? den.admin : den.members[as];
  if (!member) {
    throw new Error(`Unknown Den member ${JSON.stringify(as)}. Available: ${["admin", ...Object.keys(den.members)].join(", ")}`);
  }
  // A fine, hover-capable pointer, as in the desktop app.
  const app = await seed.appWeb({ mouse: true, ...appOptions, webPort, den: den.ref });
  await seed.signIn(app, member, as);
  const workspace = await seed.workspace(app, appOptions.workspacePath);
  return { app, workspace };
}
