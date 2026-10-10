import test from "node:test";
import assert from "node:assert/strict";

const api = await import("../electron/remote-access-network.mjs").catch(
  () => ({}),
);
const status = {
  BackendState: "Running",
  Self: { DNSName: "computer.example.ts.net.", Online: true },
};
const mapping = (port, target = "http://127.0.0.1:9288") => ({
  TCP: { [port]: { HTTPS: true } },
  Web: {
    [`computer.example.ts.net:${port}`]: {
      Handlers: { "/": { Proxy: target } },
    },
  },
});
const planner = () => {
  assert.equal(typeof api.planRemoteRoute, "function");
  return api.planRemoteRoute;
};

test("reuses the bridge's private HTTPS mapping and preserves unrelated services", () => {
  const plan = planner();
  const first = mapping(9443, "http://127.0.0.1:3000"),
    second = mapping(9444);
  const serve = {
    TCP: { ...first.TCP, ...second.TCP },
    Web: { ...first.Web, ...second.Web },
  };
  const before = structuredClone(serve);
  assert.deepEqual(plan(status, serve), {
    origin: "https://computer.example.ts.net:9444",
    port: 9444,
    create: false,
  });
  assert.deepEqual(serve, before);
});

test("new routes choose a free port without replacing occupied paths or TCP listeners", () => {
  const plan = planner();
  const serve = mapping(9443, "http://127.0.0.1:3000");
  serve.TCP[9444] = { TCPForward: "127.0.0.1:9000" };
  assert.deepEqual(plan(status, serve), {
    origin: "https://computer.example.ts.net:9445",
    port: 9445,
    create: true,
  });
});

test("rejects a Funnel route to this bridge without changing someone else's configuration", () => {
  const plan = planner(),
    serve = mapping(9443);
  serve.AllowFunnel = { "computer.example.ts.net:9443": true };
  assert.throws(() => plan(status, serve), /PUBLIC_ROUTE_CONFIGURED/);
});

test("requires signed-in Tailscale and a valid tailnet DNS name", () => {
  const plan = planner();
  assert.throws(
    () => plan({ ...status, BackendState: "NeedsLogin" }, {}),
    /TAILSCALE_SIGN_IN/,
  );
  assert.throws(
    () =>
      plan(
        { ...status, Self: { DNSName: "host.example.com", Online: true } },
        {},
      ),
    /TAILSCALE_DNS_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      plan(
        {
          ...status,
          Self: { DNSName: "host.example.ts.net/path", Online: true },
        },
        {},
      ),
    /TAILSCALE_DNS_UNAVAILABLE/,
  );
});
test("rejects a public TCP forward to the bridge", () => {
  assert.throws(
    () =>
      planner()(status, {
        TCP: { 443: { TCPForward: "127.0.0.1:9288" } },
        AllowFunnel: { "computer.example.ts.net:443": true },
      }),
    /PUBLIC_ROUTE_CONFIGURED/,
  );
});

test("fails when all candidate ports are occupied", () => {
  const plan = planner(),
    TCP = {};
  for (let port = 9443; port <= 9453; port++) TCP[port] = { HTTPS: true };
  assert.throws(() => plan(status, { TCP }), /TAILSCALE_PORTS_OCCUPIED/);
});

test("existing mapping discovery runs no Serve mutation", async () => {
  assert.equal(typeof api.createRemoteNetwork, "function");
  const calls = [];
  const network = api.createRemoteNetwork({
    run: async (args) => {
      calls.push(args);
      return args[0] === "status" ? status : mapping(9443);
    },
  });
  assert.equal(
    (await network.ensure()).origin,
    "https://computer.example.ts.net:9443",
  );
  assert.deepEqual(calls, [
    ["status", "--json", "--peers=false"],
    ["serve", "status", "--json"],
  ]);
});

test("new mapping uses a fixed loopback target and verifies the result", async () => {
  assert.equal(typeof api.createRemoteNetwork, "function");
  const calls = [];
  let created = false;
  const network = api.createRemoteNetwork({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[1] === "status") return created ? mapping(9443) : {};
      created = true;
      return null;
    },
  });
  assert.equal(
    (await network.ensure()).origin,
    "https://computer.example.ts.net:9443",
  );
  assert.deepEqual(
    calls.find((args) => args.includes("--bg")),
    ["serve", "--bg", "--https=9443", "http://127.0.0.1:9288"],
  );
  assert.equal(
    calls.some(
      (args) =>
        args.includes("--yes") ||
        args.includes("reset") ||
        args.includes("funnel"),
    ),
    false,
  );
});
