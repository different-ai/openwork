import type { HttpsRoute, SshRoute } from "@openwork/sandbox-connect";
import type { DaytonaApi } from "./api.ts";

/**
 * Routes to a guest port for `@openwork/sandbox-connect`, built on this
 * package's REST client (the `@openwork/sandbox-daytona` adapter offers the
 * same pair as `blocks.routes`). The preview proxy and the SSH gateway are
 * separate Daytona services: in run 38970708595 preview answered 502 for 70s
 * while the guest and the toolbox were healthy.
 */
export function daytonaPreviewRoute(preview: { url: string; token: string }, access: Record<string, string> = {}): HttpsRoute {
  return { kind: "https", label: "daytona-preview", url: preview.url,
    access: { ...access, "x-daytona-preview-token": preview.token, "x-daytona-skip-preview-warning": "true" } };
}

export async function daytonaSshRoute(api: DaytonaApi, sandboxId: string, port: number, access?: Record<string, string>, minutes = 60): Promise<SshRoute> {
  const ssh = await api.createSshAccess(sandboxId, minutes);
  return { kind: "ssh", label: "daytona-ssh", host: ssh.host, port: ssh.port, user: ssh.token, target: { port }, access,
    release: () => api.revokeSshAccess(sandboxId, ssh.token) };
}
