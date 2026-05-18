import { describe, expect, test } from "bun:test";

import {
  filterSessionsToWorkspace,
  type SessionScopeFilterMismatch,
} from "../src/app/lib/session-scope";

type Session = { id: string; directory?: string | null };

const session = (id: string, directory?: string | null): Session => ({ id, directory });

describe("filterSessionsToWorkspace", () => {
  test("returns server list unchanged when workspace root is empty", () => {
    const all = [session("a", "/Users/x/work"), session("b", "/Users/x/other")];
    expect(filterSessionsToWorkspace(all, "")).toEqual(all);
    expect(filterSessionsToWorkspace(all, null)).toEqual(all);
    expect(filterSessionsToWorkspace(all, undefined)).toEqual(all);
  });

  test("returns empty when the server returned no sessions", () => {
    const calls: SessionScopeFilterMismatch[] = [];
    const result = filterSessionsToWorkspace([], "/Users/x/work", {
      onMismatch: (info) => calls.push(info),
    });
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("keeps sessions whose directory matches workspace root", () => {
    const all = [
      session("a", "/Users/x/work"),
      session("b", "/Users/x/work/"),
      session("c", "/Users/x/other"),
    ];
    const result = filterSessionsToWorkspace(all, "/Users/x/work");
    expect(result.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("fails open when strict comparison drops every session", () => {
    // Mimics #1140: server returned sessions but client-side path comparison
    // would hide all of them (e.g., resolved vs unresolved symlinks). The
    // server already routed the request to this workspace's OpenCode
    // instance, so trust the server's scope rather than hiding user data.
    const calls: SessionScopeFilterMismatch[] = [];
    const all = [
      session("a", "/private/var/folders/abc/Workspace"),
      session("b", "/private/var/folders/abc/Workspace"),
    ];
    const result = filterSessionsToWorkspace(all, "/Users/me/Workspace", {
      onMismatch: (info) => calls.push(info),
    });
    expect(result).toEqual(all);
    expect(calls.length).toBe(1);
    expect(calls[0]?.totalServerSessions).toBe(2);
  });

  test("does not fire onMismatch when filter retains anything", () => {
    const calls: SessionScopeFilterMismatch[] = [];
    const all = [
      session("a", "/Users/x/work"),
      session("b", "/Users/x/other"),
    ];
    const result = filterSessionsToWorkspace(all, "/Users/x/work", {
      onMismatch: (info) => calls.push(info),
    });
    expect(result.map((s) => s.id)).toEqual(["a"]);
    expect(calls).toEqual([]);
  });

  test("treats missing session.directory as empty (filtered out, unless fail-open triggers)", () => {
    const all = [session("a"), session("b", null), session("c", "/Users/x/work")];
    const result = filterSessionsToWorkspace(all, "/Users/x/work");
    expect(result.map((s) => s.id)).toEqual(["c"]);
  });

  test("returns a fresh array (does not leak the server array reference)", () => {
    const all = [session("a", "/Users/x/work")];
    const result = filterSessionsToWorkspace(all, "/Users/x/work");
    expect(result).not.toBe(all);
  });
});
