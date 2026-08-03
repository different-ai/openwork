import { createAndSelectWorkspace, signInDesktopAs } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import type { DesktopHandle, Host } from "@openwork/hosts";
import type { Den } from "./server.ts";
import type { Place } from "./place.ts";

export interface AppOptions {
  den: Den;
  as: string;
  place: Place;
  host?: Host;
  model?: string;
}

export interface App extends DesktopHandle {
  workspaceId: string;
}

export async function app(options: AppOptions): Promise<App> {
  const member = options.as === "admin" ? options.den.admin : options.den.members[options.as];
  if (!member) {
    const available = ["admin", ...Object.keys(options.den.members)].join(", ");
    throw new Error(`Unknown Den member ${JSON.stringify(options.as)}. Available: ${available}`);
  }
  const surface = await desktop({
    name: `testkit-${options.as}`,
    host: options.host ?? options.place.host(),
    bootstrap: {
      baseUrl: options.den.ref.webUrl,
      apiBaseUrl: options.den.ref.webUrl,
      requireSignin: false,
    },
    env: options.model ? { OPENWORK_EVAL_MODEL: options.model } : undefined,
  });
  try {
    // Workspace first, then the org sign-in: the signed-in org shell offers no
    // Add workspace entry, so a member's workspace exists before they connect.
    const path = `/tmp/openwork-${options.as}-${Date.now()}`;
    await createAndSelectWorkspace(surface, { path });
    await signInDesktopAs(surface, options.den.ref, member);
    const { workspaceId } = await createAndSelectWorkspace(surface, { path });
    return {
      handle: surface.handle,
      client: surface.client,
      readiness: surface.readiness,
      workspaceRoot: surface.workspaceRoot,
      workspaceId,
      stop: () => surface.stop(),
      [Symbol.asyncDispose]: () => surface[Symbol.asyncDispose](),
    };
  } catch (error) {
    await surface[Symbol.asyncDispose]();
    throw error;
  }
}
