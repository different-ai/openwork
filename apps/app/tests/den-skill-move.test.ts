import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CloudSkillMoveCleanupError,
  saveInstalledSkillToOpenWorkOrg,
} from "../src/app/lib/den-skills";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const skillText = [
  "---",
  "name: sales-call-prep",
  "description: Prepare for sales calls.",
  "---",
  "",
  "Review the account notes.",
].join("\n");

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function setFetch(fetchImpl: typeof fetch) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl,
  });
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  const localStorage = memoryStorage();
  localStorage.setItem("openwork.den.baseUrl", "https://den.test");
  localStorage.setItem("openwork.den.authToken", "token_test");
  localStorage.setItem("openwork.den.activeOrgId", "organization_test");
  localStorage.setItem("openwork.den.activeOrgSlug", "test-org");
  localStorage.setItem("openwork.den.activeOrgName", "Test Org");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      dispatchEvent: () => true,
    },
  });
});

afterEach(() => {
  setFetch(originalFetch);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("moving an installed skill to OpenWork Cloud", () => {
  test("updates an exact Cloud match before removing the local skill", async () => {
    const events: string[] = [];
    setFetch(async (input, init) => {
      const url = String(input);
      events.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/v1/config-objects?")) {
        return response({
          items: [{
            id: "configObject_existing",
            objectType: "skill",
            title: "sales-call-prep",
            description: "Old description",
            status: "active",
            latestVersion: null,
          }],
          nextCursor: null,
        });
      }
      if (url.endsWith("/v1/config-objects/configObject_existing/versions")) {
        return response({
          ok: true,
          item: {
            id: "configObject_existing",
            objectType: "skill",
            title: "sales-call-prep",
            description: "Prepare for sales calls.",
            status: "active",
            latestVersion: null,
          },
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await saveInstalledSkillToOpenWorkOrg({
      skillText,
      removeLocalSkill: () => {
        events.push("REMOVE local");
      },
    });

    expect(result).toEqual({
      skillId: "configObject_existing",
      orgId: "organization_test",
      orgName: "Test Org",
      operation: "updated",
    });
    expect(events).toEqual([
      "GET https://den.test/api/den/v1/config-objects?type=skill&status=active&limit=100&q=sales-call-prep",
      "POST https://den.test/api/den/v1/config-objects/configObject_existing/versions",
      "REMOVE local",
    ]);
  });

  test("creates a private Cloud skill before removing the local skill", async () => {
    const events: string[] = [];
    let createBody: unknown;
    setFetch(async (input, init) => {
      const url = String(input);
      events.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/v1/config-objects?")) {
        return response({ items: [], nextCursor: null });
      }
      if (url.endsWith("/v1/plugins")) {
        createBody = JSON.parse(String(init?.body));
        return response({
          ok: true,
          item: {
            id: "plugin_created",
            name: "sales-call-prep",
            description: "Prepare for sales calls.",
            status: "active",
            componentCounts: { skill: 1 },
          },
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await saveInstalledSkillToOpenWorkOrg({
      skillText,
      removeLocalSkill: () => {
        events.push("REMOVE local");
      },
    });

    expect(result.operation).toBe("created");
    expect(createBody).toEqual({
      name: "sales-call-prep",
      description: "Prepare for sales calls.",
      components: [{ type: "skill", input: { rawSourceText: skillText } }],
      orgWide: false,
    });
    expect(events.at(-1)).toBe("REMOVE local");
  });

  test("keeps the local skill when the Cloud write fails", async () => {
    let localRemovalCalled = false;
    setFetch(async (input) => {
      const url = String(input);
      if (url.includes("/v1/config-objects?")) {
        return response({ items: [], nextCursor: null });
      }
      return response({ error: "cloud_write_failed", message: "Cloud write failed." }, 503);
    });

    await expect(saveInstalledSkillToOpenWorkOrg({
      skillText,
      removeLocalSkill: () => {
        localRemovalCalled = true;
      },
    })).rejects.toThrow("Cloud write failed.");
    expect(localRemovalCalled).toBe(false);
  });

  test("blocks an ambiguous Cloud match without writing or removing locally", async () => {
    const methods: string[] = [];
    let localRemovalCalled = false;
    setFetch(async (input, init) => {
      methods.push(init?.method ?? "GET");
      const url = String(input);
      if (!url.includes("/v1/config-objects?")) {
        throw new Error(`Unexpected request: ${url}`);
      }
      return response({
        items: ["first", "second"].map((suffix) => ({
          id: `configObject_${suffix}`,
          objectType: "skill",
          title: "sales-call-prep",
          description: null,
          status: "active",
          latestVersion: null,
        })),
        nextCursor: null,
      });
    });

    await expect(saveInstalledSkillToOpenWorkOrg({
      skillText,
      removeLocalSkill: () => {
        localRemovalCalled = true;
      },
    })).rejects.toThrow("More than one OpenWork Cloud skill");
    expect(methods).toEqual(["GET"]);
    expect(localRemovalCalled).toBe(false);
  });

  test("reports a partial move when local cleanup fails after Cloud success", async () => {
    setFetch(async (input) => {
      const url = String(input);
      if (url.includes("/v1/config-objects?")) {
        return response({ items: [], nextCursor: null });
      }
      return response({
        ok: true,
        item: {
          id: "plugin_created",
          name: "sales-call-prep",
          status: "active",
          componentCounts: { skill: 1 },
        },
      }, 201);
    });

    const move = saveInstalledSkillToOpenWorkOrg({
      skillText,
      removeLocalSkill: () => {
        throw new Error("Permission denied.");
      },
    });
    await expect(move).rejects.toBeInstanceOf(CloudSkillMoveCleanupError);
    await expect(move).rejects.toThrow("It currently exists in both places");
  });
});
