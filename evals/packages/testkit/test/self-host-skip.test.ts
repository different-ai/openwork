import assert from "node:assert/strict";
import test from "node:test";
import type { Place } from "@openwork/env";
import { selfHostServer } from "../src/self-host.ts";

test("selfHostServer skips Daytona placement", async () => {
  const place: Place = {
    kind: "daytona",
    host() {
      throw new Error("host must not be called");
    },
    async db() {
      throw new Error("db must not be called");
    },
    async exposeMock() {
      throw new Error("exposeMock must not be called");
    },
    denBase() {
      throw new Error("denBase must not be called");
    },
  };

  await assert.rejects(
    selfHostServer({ place, name: "Test", slug: "test", ownerEmails: ["owner@example.test"] }),
    (error: unknown) => error instanceof Error && error.name === "SkipError" && error.message.includes("OPENWORK_EVAL_DAYTONA"),
  );
});
