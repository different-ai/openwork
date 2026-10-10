import { test, expect } from "vitest";
import { createServer } from "node:http";
import { OpenWorkV2 } from "../src/adapters/openwork-v2-01857.js";

async function fixture(run: (a: any, state: any) => Promise<void>) {
  const state = {
    model: { providerID: "configured", id: "model-a", variant: "high" },
    active: false,
    writes: [] as string[],
    grants: [
      {
        id: "grant_owned",
        projectID: "project_owned",
        action: "external_directory",
        resource: "/synthetic",
      },
      {
        id: "grant_other",
        projectID: "project_other",
        action: "external_directory",
        resource: "/private-other",
      },
    ],
  };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const path = req.url ?? "";
    if (req.method === "POST") {
      state.writes.push(path);
      let raw = "";
      for await (const b of req) raw += b;
      state.model = JSON.parse(raw).model;
      res.end(
        JSON.stringify({
          data: { id: "ses_test", model: state.model, time: { created: 0 } },
        }),
      );
      return;
    }
    if (req.method === "DELETE") {
      state.writes.push(path);
      state.grants = state.grants.filter((g) => !path.endsWith("/" + g.id));
      res.writeHead(204);
      res.end();
      return;
    }
    res.end(
      JSON.stringify(
        path === "/health"
          ? { ok: true, version: "0.18.57" }
          : path.endsWith("/model")
            ? {
                data: [
                  {
                    providerID: "configured",
                    id: "model-a",
                    name: "Model A",
                    enabled: true,
                    variants: [{ id: "high" }],
                    apiKey: "do-not-forward",
                  },
                  {
                    providerID: "configured",
                    id: "disabled",
                    name: "Disabled",
                    enabled: false,
                    variants: [],
                  },
                ],
              }
            : path.endsWith("/active")
              ? { data: state.active ? { ses_test: { type: "running" } } : {} }
              : path.endsWith("/permission/saved")
                ? { data: state.grants }
                : path.endsWith("/permissions/mode")
                  ? {
                      mode: "default",
                      supported: false,
                      reason: "Unavailable in v2",
                      path: "/private/config",
                    }
                  : {
                      data: {
                        id: "ses_test",
                        projectID: "project_owned",
                        model: state.model,
                        time: { created: 0 },
                      },
                    },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = new OpenWorkV2(async () => ({
      origin: "http://127.0.0.1:" + (server.address() as any).port,
      token: "synthetic",
    }));
    await a.health();
    await run(a, state);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
test("model controls only expose configured enabled choices and enforce current revision and idle chat", async () =>
  fixture(async (a, s) => {
    const settings = await a.readModelSettings("ws_test", "ses_test");
    expect(settings.models).toEqual([
      {
        providerId: "configured",
        modelId: "model-a",
        name: "Model A",
        variants: ["high"],
      },
    ]);
    expect(JSON.stringify(settings)).not.toContain("do-not-forward");
    await expect(
      a.setModel(
        "ws_test",
        "ses_test",
        { providerId: "evil", modelId: "model-a", variant: null },
        settings.revision,
      ),
    ).rejects.toThrow("INVALID_MODEL");
    expect(s.writes).toHaveLength(0);
    await expect(
      a.setModel(
        "ws_test",
        "ses_test",
        { providerId: "configured", modelId: "model-a", variant: "max" },
        settings.revision,
      ),
    ).rejects.toThrow("INVALID_MODEL");
    s.model.variant = "changed";
    await expect(
      a.setModel("ws_test", "ses_test", settings.current, settings.revision),
    ).rejects.toThrow("STALE_SETTINGS");
    s.model.variant = "high";
    s.active = true;
    await expect(
      a.setModel("ws_test", "ses_test", settings.current, settings.revision),
    ).rejects.toThrow("CHAT_BUSY");
    s.active = false;
    await a.setModel(
      "ws_test",
      "ses_test",
      { providerId: "configured", modelId: "model-a", variant: null },
      settings.revision,
    );
    expect(s.writes).toHaveLength(1);
    expect(s.model).toEqual({ providerID: "configured", id: "model-a" });
    s.model.variant = "default";
    expect(
      (await a.readModelSettings("ws_test", "ses_test")).current.variant,
    ).toBeNull();
  }));
test("saved permission controls never expose or revoke another project grant and reject stale grants", async () =>
  fixture(async (a, s) => {
    const permissions = await a.readSavedPermissions("ws_test", "ses_test");
    expect(permissions.grants.map((g: any) => g.id)).toEqual(["grant_owned"]);
    expect(permissions.modeSupported).toBe(false);
    expect(JSON.stringify(permissions)).not.toContain("/private/config");
    await expect(
      a.revokeSavedPermission(
        "ws_test",
        "ses_test",
        "grant_other",
        "0".repeat(64),
      ),
    ).rejects.toThrow("STALE_PERMISSION");
    expect(s.writes).toHaveLength(0);
    const g = permissions.grants[0];
    s.grants[0].resource = "/changed";
    await expect(
      a.revokeSavedPermission("ws_test", "ses_test", g.id, g.revision),
    ).rejects.toThrow("STALE_PERMISSION");
    s.grants[0].resource = "/synthetic";
    await a.revokeSavedPermission("ws_test", "ses_test", g.id, g.revision);
    expect(s.grants.map((g: any) => g.id)).toEqual(["grant_other"]);
    expect(s.writes).toHaveLength(1);
  }));
