import { describe, expect, test } from "bun:test";

import type { ExtensionActionContribution } from "./action-contract.js";
import { createExtensionActionRegistry } from "./action-registry.js";
import { createExtensionActionService } from "./action-service.js";

function action(extensionId: string, actionId: string): ExtensionActionContribution {
  return {
    descriptor: {
      extensionId,
      action: actionId,
      title: `${extensionId} ${actionId}`,
      description: `${extensionId} ${actionId} description`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async ({ args, clientContext }) => ({
      ok: true,
      extensionId,
      action: actionId,
      result: args,
      context: clientContext,
    }),
  };
}

describe("server extension action registry adapter", () => {
  test("assembles a fake action without changing dispatch and preserves composition order", async () => {
    const contributions = [
      action("fake", "second"),
      action("fake", "first"),
      action("other", "first"),
    ];
    const service = createExtensionActionService(createExtensionActionRegistry(contributions));

    expect(service.list("").map((item) => `${item.extensionId}/${item.action}`)).toEqual([
      "fake/second",
      "fake/first",
      "other/first",
    ]);
    expect(await service.call({
      extensionId: "fake",
      action: "first",
      args: { value: 1 },
      context: { source: "test" },
    })).toEqual({
      ok: true,
      extensionId: "fake",
      action: "first",
      result: { value: 1 },
      context: { source: "test" },
    });
  });

  test("rejects duplicate extension/action tuples during composition", () => {
    expect(() => createExtensionActionRegistry([
      action("fake", "run"),
      action("fake", "run"),
    ])).toThrow(
      'Invalid server extension action composition: Contribution id "fake/run" is already registered.',
    );
  });

  test("keeps registries realm-local rather than sharing module state", () => {
    const first = createExtensionActionRegistry([action("fake", "run")]);
    const second = createExtensionActionRegistry([action("fake", "run")]);
    expect(first.list()).toHaveLength(1);
    expect(second.list()).toHaveLength(1);
  });
});
