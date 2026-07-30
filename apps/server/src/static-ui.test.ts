import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticUi } from "./static-ui.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const WEB_BOOTSTRAP_TOKEN_ENV = "OPENWORK_WEB_BOOTSTRAP_TOKEN";

async function createWebRoot() {
  const root = join(tmpdir(), `openwork-static-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<html><head><title>OpenWork</title></head><body>App shell</body></html>");
  await writeFile(join(root, "overlay.html"), "<html><head></head><body>Overlay</body></html>");
  await writeFile(join(root, "assets", "app.123.js"), "console.log('app');");
  await writeFile(join(root, "assets", "style.123.css"), "body { color: black; }");
  await writeFile(join(root, "data.json"), "{\"ok\":true}");
  await writeFile(join(root, "icon.svg"), "<svg></svg>");
  return root;
}

async function withWebRoot(root: string | null, run: () => Promise<void>) {
  const previous = process.env.OPENWORK_WEB_ROOT;
  if (root) {
    process.env.OPENWORK_WEB_ROOT = root;
  } else {
    delete process.env.OPENWORK_WEB_ROOT;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENWORK_WEB_ROOT;
    } else {
      process.env.OPENWORK_WEB_ROOT = previous;
    }
  }
}

async function withBootstrapTokenEnv(value: string | null, run: () => Promise<void>) {
  const previous = process.env[WEB_BOOTSTRAP_TOKEN_ENV];
  if (value === null) {
    delete process.env[WEB_BOOTSTRAP_TOKEN_ENV];
  } else {
    process.env[WEB_BOOTSTRAP_TOKEN_ENV] = value;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[WEB_BOOTSTRAP_TOKEN_ENV];
    } else {
      process.env[WEB_BOOTSTRAP_TOKEN_ENV] = previous;
    }
  }
}

function staticConfig(token = "client-token") {
  return { token };
}

function serverConfig(root: string, port: number): ServerConfig {
  return {
    host: "127.0.0.1",
    port,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "default",
        name: "Default",
        path: root,
        preset: "default",
        workspaceType: "local",
      },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("serveStaticUi", () => {
  test("is a no-op when OPENWORK_WEB_ROOT is unset", async () => {
    await withWebRoot(null, async () => {
      const response = await serveStaticUi(new Request("http://openwork.test/"), staticConfig());
      expect(response).toBeNull();
    });
  });

  test("rejects path traversal", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const response = await serveStaticUi(new Request("http://openwork.test/safe%2F..%2F..%2Fsecret.txt"), staticConfig());
      if (!response) throw new Error("expected traversal response");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "path_escape", message: "Path escapes workspace root" });
    });
  });

  test("serves configured MIME types", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const js = await serveStaticUi(new Request("http://openwork.test/assets/app.123.js"), staticConfig());
      const css = await serveStaticUi(new Request("http://openwork.test/assets/style.123.css"), staticConfig());
      const json = await serveStaticUi(new Request("http://openwork.test/data.json"), staticConfig());
      const svg = await serveStaticUi(new Request("http://openwork.test/icon.svg"), staticConfig());
      if (!js || !css || !json || !svg) throw new Error("expected static responses");
      expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
      expect(json.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(svg.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    });
  });

  test("uses immutable cache headers for assets", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const response = await serveStaticUi(new Request("http://openwork.test/assets/app.123.js"), staticConfig());
      if (!response) throw new Error("expected asset response");
      expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE_CACHE);
    });
  });

  test("falls back to index.html for SPA routes", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const response = await serveStaticUi(new Request("http://openwork.test/settings/general"), staticConfig(""));
      if (!response) throw new Error("expected SPA fallback response");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(await response.text()).toContain("App shell");
    });
  });

  test("leaves missing assets on the existing JSON 404 path while SPA routes fallback", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const server = await startServer(serverConfig(root, 0));
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const missingAsset = await fetch(`${base}/assets/app-DEADBEEF.js`);
        expect(missingAsset.status).toBe(404);
        expect(missingAsset.headers.get("Content-Type")).toBe("application/json");
        expect(await missingAsset.json()).toEqual({ code: "not_found", message: "Not found" });

        const route = await fetch(`${base}/settings/general`);
        expect(route.status).toBe(200);
        expect(route.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(await route.text()).toContain("App shell");
      } finally {
        await server.stop();
      }
    });
  });

  test("serves overlay.html directly without using it as the fallback", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const overlay = await serveStaticUi(new Request("http://openwork.test/overlay.html"), staticConfig());
      const fallback = await serveStaticUi(new Request("http://openwork.test/missing-route"), staticConfig(""));
      if (!overlay || !fallback) throw new Error("expected overlay and fallback responses");
      expect(await overlay.text()).toContain("Overlay");
      expect(await fallback.text()).toContain("App shell");
    });
  });

  test("injects escaped bootstrap JSON into index.html", async () => {
    const root = await createWebRoot();
    await withBootstrapTokenEnv(null, async () => {
      await withWebRoot(root, async () => {
        const response = await serveStaticUi(new Request("http://openwork.test/"), staticConfig("tok<\u2028>\u2029&"));
        if (!response) throw new Error("expected index response");
        const body = await response.text();
        expect(body).toContain("<script>window.__OPENWORK_BOOTSTRAP__ = {\"token\":\"tok\\u003c\\u2028\\u003e\\u2029\\u0026\"}</script></head>");
        expect(body).not.toContain("tok<");
      });
    });
  });

  test("can disable bootstrap token injection", async () => {
    const root = await createWebRoot();
    for (const value of ["0", "false"]) {
      await withBootstrapTokenEnv(value, async () => {
        await withWebRoot(root, async () => {
          const response = await serveStaticUi(new Request("http://openwork.test/"), staticConfig("client-token"));
          if (!response) throw new Error("expected index response");
          const body = await response.text();
          expect(body).toContain("App shell");
          expect(body).not.toContain("__OPENWORK_BOOTSTRAP__");
        });
      });
    }
  });

  test("leaves non-GET route misses on the existing JSON 404 path", async () => {
    const root = await createWebRoot();
    await withWebRoot(root, async () => {
      const server = await startServer(serverConfig(root, 0));
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/definitely-not-a-route`, { method: "POST" });
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Type")).toBe("application/json");
        expect(await response.json()).toEqual({ code: "not_found", message: "Not found" });
      } finally {
        await server.stop();
      }
    });
  });
});
