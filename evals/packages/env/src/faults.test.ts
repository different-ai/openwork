import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { allocateFreePort } from "@openwork/cdp";
import { FAULT_PROXY_SCRIPT } from "../../hosts/src/fault-proxy-script.ts";
import { eventually } from "./eventually.ts";
import { faultProxy } from "./faults.ts";

async function fixture(lane: string, resources: AsyncDisposableStack) {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  resources.defer(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Upstream did not bind.");
  const upstreamUrl = `http://127.0.0.1:${address.port}`;
  if (lane === "local") {
    const proxy = resources.use(await faultProxy({ apiUrl: upstreamUrl, webUrl: upstreamUrl }));
    return {
      url: proxy.ref.webUrl,
      status: (headers?: Record<string, string>) => proxy.faults.status("/token", 429, { times: 1, method: "POST", body: { error: "slow_down" }, headers }),
      delay: () => proxy.faults.latency("/held", 150, { times: 1 }),
      arrivals: async (): Promise<unknown[]> => {
        if (!proxy.arrivals) throw new Error("Missing request arrivals.");
        return proxy.arrivals();
      },
    };
  }
  const port = await allocateFreePort();
  const child = spawn(process.execPath, ["--input-type=module", "-e", FAULT_PROXY_SCRIPT], {
    env: { ...process.env, PORT: String(port), UPSTREAM: upstreamUrl, ISSUER: "fault-unit", CONTROL_TOKEN: "fault-unit-control" }, stdio: "ignore",
  });
  resources.defer(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  const url = `http://127.0.0.1:${port}`;
  await eventually(async () => (await fetch(`${url}/__openwork_faults/health`)).ok, { within: 10_000, intervalMs: 25 });
  const rule = async (body: unknown) => {
    const response = await fetch(`${url}/__openwork_faults/rules`, { method: "POST", headers: { "x-openwork-fault-token": "fault-unit-control", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(204);
  };
  return {
    url,
    status: (headers?: Record<string, string>) => rule({ kind: "status", pathPrefix: "/token", statusCode: 429, times: 1, method: "POST", body: { error: "slow_down" }, headers }),
    delay: () => rule({ kind: "latency", pathPrefix: "/held", delayMs: 150, times: 1 }),
    arrivals: async (): Promise<unknown[]> => {
      const response = await fetch(`${url}/__openwork_faults/requests`, { headers: { "x-openwork-fault-token": "fault-unit-control" } });
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("arrivals" in body) || !Array.isArray(body.arrivals)) throw new Error("Missing request arrivals.");
      return body.arrivals;
    },
  };
}

for (const lane of ["local", "sandbox-script"]) {
  test(`${lane} fault responses preserve optional Retry-After`, async () => {
    await using resources = new AsyncDisposableStack();
    const proxy = await fixture(lane, resources);
    await proxy.status({ "Retry-After": "17" });
    const limited = await fetch(`${proxy.url}/token`, { method: "POST" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    expect(await limited.json()).toEqual({ error: "slow_down" });
    expect((await fetch(`${proxy.url}/token`, { method: "POST" })).status).toBe(200);
    await proxy.status();
    expect((await fetch(`${proxy.url}/token`, { method: "POST" })).headers.get("retry-after")).toBeNull();
  });

  for (const cancel of [false, true]) {
    test(`${lane} records an arrival before a delayed request ${cancel ? "is cancelled" : "completes"}`, async () => {
      await using resources = new AsyncDisposableStack();
      const proxy = await fixture(lane, resources);
      await proxy.delay();
      const controller = new AbortController();
      let settled = false;
      const held = fetch(`${proxy.url}/held`, { signal: controller.signal })
        .catch((error: unknown) => error)
        .finally(() => { settled = true; });
      const observed = await eventually(proxy.arrivals, { within: 5_000, intervalMs: 10, until: values => values.some(value => typeof value === "object" && value !== null && "path" in value && value.path === "/held") });
      expect(observed).toContainEqual(expect.objectContaining({ path: "/held", faulted: true }));
      expect(settled).toBe(false);
      if (cancel) {
        controller.abort();
        expect(await held).toMatchObject({ name: "AbortError" });
      } else {
        const response = await held;
        expect(response).toBeInstanceOf(Response);
        if (!(response instanceof Response)) throw response;
        expect(response.status).toBe(200);
      }
      expect(await proxy.arrivals()).toContainEqual(expect.objectContaining({ path: "/held", faulted: true }));
    });
  }
}
