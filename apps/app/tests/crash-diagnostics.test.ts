import { expect, test } from "bun:test";
import { formatCrashDiagnostic, redactCrashText } from "../src/app/lib/crash-diagnostics";

test("ordinary Errors retain names and lazy stacks without arbitrary object coercion", () => {
  const error = new TypeError("synthetic ordinary failure");
  expect(formatCrashDiagnostic(error)).toEqual({ name: "TypeError", message: error.message, stack: error.stack ?? "" });
  let conversions = 0;
  const hostile = { toString() { conversions++; throw hostile; }, [Symbol.toPrimitive]() { conversions++; throw hostile; } };
  expect(formatCrashDiagnostic(hostile)).toEqual({ name: "Error", message: "An unexpected error occurred.", stack: "" });
  expect(conversions).toBe(0);
});

test.each([null, undefined, 7, false, Symbol("synthetic"), 12n])("primitive thrown value %s is safely described", (value) => {
  expect(formatCrashDiagnostic(value)).toEqual({ name: "Error", message: String(value), stack: "" });
});

test("throwing getters and revoked or throwing proxies cannot escape formatting", () => {
  let reads = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "message", "stack"].map(key => [key, { get() { reads++; throw hostile; } }])));
  expect(formatCrashDiagnostic(hostile)).toEqual({ name: "Error", message: "An unexpected error occurred.", stack: "" });
  expect(reads).toBe(3);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [revoked.proxy, new Proxy({}, { get() { throw hostile; } })]) {
    expect(formatCrashDiagnostic(value)).toEqual({ name: "Error", message: "An unexpected error occurred.", stack: "" });
  }
});

test("non-string diagnostic fields are not coerced and inherited names remain useful", () => {
  const poison = { toString() { throw new Error("must not run"); } };
  expect(formatCrashDiagnostic({ name: poison, message: poison, stack: poison })).toEqual({ name: "Error", message: "An unexpected error occurred.", stack: "" });
  expect(formatCrashDiagnostic("synthetic rejection", "UnhandledRejection").name).toBe("UnhandledRejection");
});

test("one idempotent path sanitizes mixed credentials and preserves frame syntax", () => {
  const source = 'Authorization: bEaReR FAKE_BEARER_0123+/== api_key=FAKE_API\n    at Child (https://FAKE_USER:FAKE_PASSWORD@asset.invalid/chunk.js?api_key=FAKE_QUERY#FAKE_FRAGMENT:12:34)';
  const clean = redactCrashText(source);
  expect(clean).not.toContain("FAKE_");
  expect(clean).toContain("Bearer [REDACTED]");
  expect(clean).toContain("api_key=[redacted]");
  expect(clean).toContain("at Child (https://asset.invalid/chunk.js:12:34)");
  expect(redactCrashText(clean)).toBe(clean);
  const diagnostic = formatCrashDiagnostic({ name: source, message: source, stack: source });
  expect(JSON.stringify(diagnostic)).not.toContain("FAKE_");
});

test("long diagnostics are bounded after sanitizing, without masking ordinary text or HTML", () => {
  const diagnostic = formatCrashDiagnostic({ name: "N".repeat(50000), message: "m".repeat(50000), stack: "s".repeat(50000) });
  expect(diagnostic.name).toHaveLength(100);
  expect(diagnostic.message).toHaveLength(1000);
  expect(diagnostic.stack).toHaveLength(8000);
  const html = '<img src=x onerror="synthetic()"><script>synthetic()</script>';
  expect(redactCrashText(html)).toBe(html);
  expect(redactCrashText("Useful error: loading model, status=502" )).toBe("Useful error: loading model, status=502");
  expect(redactCrashText("x".repeat(995) + " Bearer FAKE_TRAILING_TOKEN").slice(0, 1000)).not.toContain("FAKE_");
});
