import { describe, expect, test } from "bun:test";

import { ApiError } from "../errors.js";
import type { ExtensionActionContribution } from "./action-contract.js";
import { createExtensionActionService, type ExtensionActionRegistryPort } from "./action-service.js";

function registryFor(contributions: ExtensionActionContribution[]): ExtensionActionRegistryPort {
  return {
    list: () => [...contributions],
    lookup: (extensionId, action) => contributions.find((item) => (
      item.descriptor.extensionId === extensionId && item.descriptor.action === action
    )),
  };
}

function contribution(input: {
  extensionId: string;
  action: string;
  title: string;
  execute?: ExtensionActionContribution["execute"];
  isListed?: ExtensionActionContribution["isListed"];
}): ExtensionActionContribution {
  return {
    descriptor: {
      extensionId: input.extensionId,
      action: input.action,
      title: input.title,
      description: `${input.title} description`,
      inputSchema: { type: "object" },
    },
    execute: input.execute,
    isListed: input.isListed,
  };
}

describe("extension action service", () => {
  test("lists in registry order, trims filters, and applies host listing policy", () => {
    const service = createExtensionActionService(registryFor([
      contribution({ extensionId: "alpha", action: "first", title: "First", execute: async () => ({}) }),
      contribution({
        extensionId: "alpha",
        action: "hidden",
        title: "Hidden",
        execute: async () => ({}),
        isListed: ({ connectSnapshot }) => connectSnapshot?.connectEnabled !== true,
      }),
      contribution({ extensionId: "beta", action: "second", title: "Second", execute: async () => ({}) }),
    ]));

    expect(service.list(" alpha ").map((item) => item.action)).toEqual(["first", "hidden"]);
    expect(service.list("alpha", {
      connectSnapshot: {
        connectEnabled: true,
        cloudMcpPresent: false,
        googleWorkspace: { legacyConfigured: false },
      },
    }).map((item) => item.action)).toEqual(["first"]);
    expect(service.list("").map((item) => `${item.extensionId}/${item.action}`)).toEqual([
      "alpha/first",
      "alpha/hidden",
      "beta/second",
    ]);
    expect(service.list("unknown")).toEqual([]);
  });

  test("normalizes args and client context without changing the call envelope", async () => {
    const calls: unknown[] = [];
    const service = createExtensionActionService(registryFor([
      contribution({
        extensionId: "fake",
        action: "run",
        title: "Run fake action",
        execute: async (invocation) => {
          calls.push(invocation);
          return { ok: true, args: invocation.args, context: invocation.clientContext };
        },
      }),
    ]));

    expect(await service.call({ extensionId: " fake ", action: " run ", args: null, context: "nope" })).toEqual({
      ok: true,
      args: {},
      context: {},
    });
    expect(calls).toHaveLength(1);
  });

  test("preserves legacy validation, unknown, and declared-only errors", async () => {
    const service = createExtensionActionService(registryFor([
      contribution({ extensionId: "fake", action: "declared", title: "Declared action" }),
    ]));

    expect(service.call(null)).rejects.toEqual(
      new ApiError(400, "invalid_payload", "Expected extension action call payload"),
    );
    expect(service.call({ extensionId: "fake" })).rejects.toEqual(
      new ApiError(400, "invalid_payload", "extensionId and action are required"),
    );
    expect(service.call({ extensionId: "fake", action: "missing" })).rejects.toEqual(
      new ApiError(404, "extension_action_not_found", "OpenWork extension action not found"),
    );
    expect(service.call({ extensionId: "fake", action: "declared", args: { value: 1 } })).rejects.toEqual(
      new ApiError(
        501,
        "extension_action_not_implemented",
        "Declared action is registered but not implemented on openwork-server yet.",
        { extensionId: "fake", action: "declared", args: { value: 1 } },
      ),
    );
  });
});
