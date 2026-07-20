import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployDenApiTag,
  releaseVersionFromTag,
} from "./deploy-den-api-tag.mjs";

const commitSha = "1234567890abcdef1234567890abcdef12345678";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderMock({
  previousVersion = { exists: true, value: "dev" },
  healthVersion = "0.18.0",
} = {}) {
  const requests = [];
  let deployPoll = 0;

  return {
    requests,
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ method, path: `${url.pathname}${url.search}`, body });

      if (url.origin === "https://den.example.com") {
        return json({
          ok: true,
          service: "den-api",
          version: healthVersion,
        });
      }
      if (method === "GET" && url.pathname === "/v1/services/srv-den") {
        return json({
          id: "srv-den",
          repo: "https://github.com/different-ai/openwork",
          serviceDetails: {
            runtime: "docker",
            url: "https://den.example.com",
          },
        });
      }
      if (method === "GET" && url.pathname.endsWith("/env-vars")) {
        return json(
          previousVersion.exists
            ? [{
                envVar: {
                  key: "DEN_API_VERSION",
                  value: previousVersion.value,
                },
                cursor: "cursor-1",
              }]
            : [],
        );
      }
      if (
        method === "PUT" &&
        url.pathname.endsWith("/env-vars/DEN_API_VERSION")
      ) {
        return json({ key: "DEN_API_VERSION", value: body.value });
      }
      if (
        method === "DELETE" &&
        url.pathname.endsWith("/env-vars/DEN_API_VERSION")
      ) {
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && url.pathname.endsWith("/deploys")) {
        return json({ id: "dep-release" }, 201);
      }
      if (method === "GET" && url.pathname.endsWith("/deploys/dep-release")) {
        deployPoll += 1;
        return json({
          id: "dep-release",
          status: deployPoll === 1 ? "build_in_progress" : "live",
        });
      }

      return json({ error: "not found" }, 404);
    },
  };
}

test("derives the release number from a semver Git tag", () => {
  assert.equal(releaseVersionFromTag("v0.18.0"), "0.18.0");
  assert.equal(releaseVersionFromTag("v1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => releaseVersionFromTag("feature/release"), /valid semver/);
});

test("deploys the tagged commit, verifies health, and restores dev", async () => {
  const mock = renderMock();

  const result = await deployDenApiTag({
    tag: "v0.18.0",
    commitSha,
    apiKey: "render-test-key",
    serviceId: "srv-den",
    apiBase: "https://api.render.test/v1",
    fetchImpl: mock.fetch,
    sleep: async () => {},
    pollIntervalMs: 0,
    healthPollIntervalMs: 0,
    log: () => {},
  });

  assert.deepEqual(result, {
    deployId: "dep-release",
    version: "0.18.0",
  });
  assert.deepEqual(
    mock.requests
      .filter((request) => request.method === "PUT")
      .map((request) => request.body),
    [{ value: "0.18.0" }, { value: "dev" }],
  );
  assert.deepEqual(
    mock.requests.find((request) => request.method === "POST")?.body,
    { commitId: commitSha },
  );
  assert.ok(
    mock.requests.some(
      (request) =>
        request.method === "GET" && request.path === "/health",
    ),
  );
});

test("removes a temporary version when no direct setting existed", async () => {
  const mock = renderMock({
    previousVersion: { exists: false, value: null },
  });

  await deployDenApiTag({
    tag: "v0.18.0",
    commitSha,
    apiKey: "render-test-key",
    serviceId: "srv-den",
    apiBase: "https://api.render.test/v1",
    fetchImpl: mock.fetch,
    sleep: async () => {},
    pollIntervalMs: 0,
    healthPollIntervalMs: 0,
    log: () => {},
  });

  assert.ok(
    mock.requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.path.endsWith("/env-vars/DEN_API_VERSION"),
    ),
  );
});

test("fails a mismatched live version and still restores the prior setting", async () => {
  const mock = renderMock({ healthVersion: "commit 1234567" });

  await assert.rejects(
    deployDenApiTag({
      tag: "v0.18.0",
      commitSha,
      apiKey: "render-test-key",
      serviceId: "srv-den",
      apiBase: "https://api.render.test/v1",
      fetchImpl: mock.fetch,
      sleep: async () => {},
      pollIntervalMs: 0,
      healthPollIntervalMs: 0,
      maxHealthPolls: 1,
      log: () => {},
    }),
    /did not report release 0\.18\.0/,
  );

  assert.deepEqual(
    mock.requests
      .filter((request) => request.method === "PUT")
      .map((request) => request.body),
    [{ value: "0.18.0" }, { value: "dev" }],
  );
});
