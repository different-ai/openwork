import { expect, test } from "bun:test";
import { classifyCalendarError } from "./adapters";

const denied = (status: number, code: string) => Object.assign(new Error("Calendar access unavailable"), { status, code });

test("explicit and generic authorization denials remain blocked calendar states", () => {
  for (const provider of ["google", "microsoft"] satisfies Array<"google" | "microsoft">) {
    expect(classifyCalendarError(provider, denied(403, "policy_blocked")).kind).toBe("policy_blocked");
    expect(classifyCalendarError(provider, denied(403, "forbidden")).kind).toBe("permission_missing");
    expect(classifyCalendarError(provider, denied(401, "unauthorized")).kind).toBe("auth_expired");
    expect(classifyCalendarError(provider, denied(403, "forbidden")).retryable).toBe(false);
  }
});

test("transport failures are retryable unknown reads, not authorization denials", () => {
  const failure = classifyCalendarError("google", new Error("Connection reset"));
  expect(failure.kind).toBe("network");
  expect(failure.retryable).toBe(true);
});
