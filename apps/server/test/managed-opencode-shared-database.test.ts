import { describe, expect, test } from "bun:test";
import { foreignStorageExit, ManagedOpencodeExitError } from "../src/managed-opencode.js";

const v2Owned = new ManagedOpencodeExitError(1, "Error: Unexpected error\nDatabase is not empty and has no session table", false);

describe("engine v1 on a database OpenCode v2 already owns", () => {
  test("moves v1's database on the default path", () => {
    expect(foreignStorageExit(v2Owned, { HOME: "/home/a" })).toBe("database");
  });

  test("moves v1's database when OPENCODE_DB is explicit (isolated test and preview profiles)", () => {
    // OpenWork hands the same explicit path to its own v2 engine, so the collision happens there too.
    expect(foreignStorageExit(v2Owned, { OPENCODE_DB: "/profile/opencode/data/opencode.db" })).toBe("database");
  });

  test("leaves other exits alone", () => {
    expect(foreignStorageExit(new ManagedOpencodeExitError(1, "some other failure", false), {})).toBeNull();
    expect(foreignStorageExit(new ManagedOpencodeExitError(2, "Database is not empty and has no session table", false), {})).toBeNull();
    expect(foreignStorageExit(new Error("Database is not empty and has no session table"), {})).toBeNull();
  });
});
