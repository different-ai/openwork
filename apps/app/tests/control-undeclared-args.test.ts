import { describe, expect, test } from "bun:test";

import { undeclaredArgsError } from "../src/react-app/shell/control/undeclared-args";

const readTranscript = { id: "session.read_transcript", args: [{ name: "count" }] };

describe("undeclaredArgsError", () => {
  test("a sessionId on the current-chat transcript query is refused, not ignored", () => {
    expect(undeclaredArgsError(readTranscript, { sessionId: "ses_other", count: 30 }))
      .toBe('Unknown argument "sessionId" for session.read_transcript. Valid arguments: count.');
  });

  test("declared arguments, no arguments, and actions that declare none pass", () => {
    expect(undeclaredArgsError(readTranscript, { count: 30 })).toBeNull();
    expect(undeclaredArgsError(readTranscript, undefined)).toBeNull();
    expect(undeclaredArgsError({ id: "session.open" }, { anything: true })).toBeNull();
  });

  test("an action that takes no arguments says so", () => {
    expect(undeclaredArgsError({ id: "auth.status", args: [] }, { verbose: true }))
      .toBe('Unknown argument "verbose" for auth.status. It takes no arguments.');
  });
});
