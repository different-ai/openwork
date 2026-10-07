import { afterEach, expect, test, vi } from "vitest";
import { launchPreview, deletePreview } from "@openwork/freestyle";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test("Workbot preview keeps TTL/TLS/access guards while shared compute owns create and delete", async () => {
  const sha = "a".repeat(40);
  let created: Record<string, unknown> = {};
  let deletes = 0;
  const api: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("/snapshots/")) return Response.json({ id: "image", createdAt: new Date().toISOString() });
    if (url.pathname === "/v5/vms" && init?.method === "POST") {
      created = JSON.parse(String(init.body));
      return Response.json({ id: "vm-test", slug: created.slug, state: "running", metadata: created.metadata, createdAt: new Date().toISOString() });
    }
    if (init?.method === "DELETE") { deletes++; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/fs/write")) { expect(url.searchParams.get("mode")).toBe("384"); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/fs/read")) return new Response("{}");
    return Response.json({ id: "vm-test", slug: created.slug, state: "running", metadata: created.metadata, createdAt: new Date().toISOString() });
  };
  vi.stubEnv("FREESTYLE_API_KEY", "test-only");
  vi.stubGlobal("fetch", api);
  const probe: typeof fetch = async (_, init) => init?.headers
    ? new Response("OpenWork")
    : new Response(null, { status: 303, headers: { "set-cookie": "__Host-openwork-preview=test" } });
  const preview = await launchPreview({ gitSha: sha, world: "workbot", lifetimeMinutes: 15 }, undefined, probe);
  expect(created.ttlSeconds).toBe(900);
  expect(created.idleTimeoutSeconds).toBe(600);
  expect(created.tls).toBeDefined();
  expect(preview.world).toBe("workbot");
  expect(preview.url).toContain("&then=workbot");
  await deletePreview(preview.id);
  expect(deletes).toBe(1);
});
