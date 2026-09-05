import type { DenRef, DenSession } from "@openwork/behaviors";
import type { Den } from "./den.ts";
import {
  DEMO_PASSWORD,
  ensureKindDenReady,
  exposeEndpointHandles,
  kubeProfileConfig,
} from "./kind-stack.ts";

function endpointPort(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`Kind endpoint has no explicit port: ${url}`);
  }
  return port;
}

/** Attach to the shared Kind Den while owning only its local port-forwards. */
export async function kindServer(): Promise<Den> {
  await ensureKindDenReady();
  const endpoints = await exposeEndpointHandles(kubeProfileConfig("single-org"));
  const ref: DenRef = { apiUrl: endpoints.apiUrl, webUrl: endpoints.webUrl };
  try {
    const admin: DenSession = {
      ...ref,
      token: endpoints.token,
      email: endpoints.adminEmail,
      password: DEMO_PASSWORD,
    };
    let disposed = false;
    return {
      ref,
      placement: { kind: "local" },
      admin,
      members: {},
      mocks: {},
      ports: {
        api: endpointPort(ref.apiUrl),
        web: endpointPort(ref.webUrl),
      },
      async apiLog(): Promise<string> {
        throw new Error(
          "den.apiLog() is not available for kind worlds; read the shared den-api deployment logs with kubectl.",
        );
      },
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        await endpoints.stop();
      },
    };
  } catch (error) {
    await endpoints.stop();
    throw error;
  }
}
