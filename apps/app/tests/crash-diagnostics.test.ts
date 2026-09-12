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

test.each([
  ["password containing an unescaped @", "https://user:p@ss@host/path", "https://host/path"],
  ["multiple @ in userinfo", "https://a@b@c@host/path", "https://host/path"],
  ["encoded %40 in userinfo", "https://user%40mail.invalid:pw@host/path", "https://host/path"],
  ["only encoded %40 as the userinfo delimiter", "https://user:pw%40host/path", "https://host/path"],
  ["no path after the authority", "https://user:pw@host", "https://host"],
  ["port survives userinfo removal", "https://user:p@ss@host:8443/path", "https://host:8443/path"],
  ["non-http scheme", "postgres://user:p@ss@db.invalid:5432/app", "postgres://db.invalid:5432/app"],
  ["userinfo before a query-only URL", "https://user:p@ss@host?token=FAKE_QUERY", "https://host"],
])("userinfo stripping handles %s", (_label, url, expected) => {
  expect(redactCrashText(url)).toBe(expected);
  expect(redactCrashText(url)).not.toContain("FAKE_");
  expect(redactCrashText(url)).not.toMatch(/p@ss|pw/);
});

test.each([
  ["an @ only in the path", "https://host/mail/a@b"],
  ["an @ only in the fragment-free query-less path", "wss://host.invalid/rooms/team@example"],
  ["no userinfo at all", "https://asset.invalid/chunk.js"],
  ["no userinfo and a port", "http://127.0.0.1:3000/health"],
])("URLs with %s are unchanged", (_label, url) => {
  expect(redactCrashText(url)).toBe(url);
});

test("userinfo cut by the work bound before its @ cannot survive into any bounded field", () => {
  const prefix = "x".repeat(7000) + " https://user:";
  const source = prefix + "FAKE_".repeat(2500) + "@host/path";
  expect(source.indexOf("@")).toBeGreaterThan(16000);
  const clean = redactCrashText(source);
  expect(clean).toBe("x".repeat(7000) + " https://");
  expect(redactCrashText(clean)).toBe(clean);
  const diagnostic = formatCrashDiagnostic({ name: source, message: source, stack: source });
  expect(JSON.stringify(diagnostic)).not.toMatch(/FAKE_|user:/);
  // A URL whose authority ended before the bound keeps its host even when its path is cut.
  const pathCut = "https://user:p@ss@host/" + "a".repeat(20000);
  expect(redactCrashText(pathCut)).toBe("https://host/" + "a".repeat(16000 - "https://host/".length - "user:p@ss@".length));
  // A complete URL that merely ends at the bound is not mistaken for a cut one.
  const exact = "y".repeat(16000 - "https://host".length) + "https://host";
  expect(redactCrashText(exact)).toBe(exact);
});

test.each([
  ["double-quoted value", 'token="DEMO_SECRET"', "token=[redacted]"],
  ["single-quoted value", "key='abc'", "key=[redacted]"],
  ["double-quoted value containing & and )", 'secret="a&b)")', "secret=[redacted])"],
  ["single-quoted value containing & and )", "code='x&y)')", "code=[redacted])"],
  ["unquoted value followed by )", "grant=abc)", "grant=[redacted])"],
  ["unquoted value followed by ) in a stack frame", "at fn (file?token=abc)", "at fn (file?token=[redacted])"],
])("redacts %s", (_label, input, expected) => {
  expect(redactCrashText(input)).toBe(expected);
  expect(redactCrashText(input)).not.toContain("DEMO_SECRET");
  expect(redactCrashText(input)).not.toContain("abc");
});

test("JSON colon syntax redacts the value while retaining the key", () => {
  expect(redactCrashText('{"token":"abc"}')).toBe('{"token":"[redacted]"}');
});

test.each(["token", "grant", "code", "secret", "key", "password", "authorization"])("JSON redacts %s across quote and scalar forms", (key) => {
  for (const quote of ['"', "'"]) {
    for (const value of ['"OPAQUE_VALUE"', "'OPAQUE_VALUE'", "OPAQUE_VALUE", "123", "false", '""']) {
      const prefix = `{${quote}${key.toUpperCase()}${quote} : `;
      const clean = redactCrashText(`${prefix}${value}, "status":"useful"}`);
      expect(clean).toBe(`${prefix}"[redacted]", "status":"useful"}`);
      expect(redactCrashText(clean)).toBe(clean);
    }
  }
});

test("JSON quoted secrets include escaped quotes and do not mask unrelated keys", () => {
  expect(redactCrashText(String.raw`{"token":"opaque\"remainder", "status":"useful"}`))
    .toBe('{"token":"[redacted]", "status":"useful"}');
  expect(redactCrashText(String.raw`{'secret':'opaque\'remainder', 'status':'useful'}`))
    .toBe(`{'secret':"[redacted]", 'status':'useful'}`);
  expect(redactCrashText('{"tokenCount":3,"monkey":"useful"}')).toBe('{"tokenCount":3,"monkey":"useful"}');
});

test.each(["Authorization: Bearer", "authorization: bEaReR", "Bearer"])("redacts %s header credentials", (prefix) => {
  const clean = redactCrashText(`${prefix} OPAQUE_HEADER+/==`);
  expect(clean).toBe(`${prefix.replace(/bearer/i, "Bearer")} [REDACTED]`);
});

test.each(['"', "'"])("quoted secrets with %s closing beyond the work cutoff fail closed", (quote) => {
  for (const prefix of [`token=${quote}`, `{"token":${quote}`]) {
    const source = prefix + "OPAQUE_CUTOFF_" + "x".repeat(17000) + quote;
    expect(source.lastIndexOf(quote)).toBeGreaterThan(16000);
    const expected = prefix.startsWith("{") ? '{"token":"[redacted]"' : "token=[redacted]";
    expect(redactCrashText(source)).toBe(expected);
    expect(formatCrashDiagnostic({ name: source, message: source, stack: source }))
      .toEqual({ name: expected, message: expected, stack: expected });
  }
});

test("long diagnostics are bounded after sanitizing, without masking ordinary text or HTML", () => {
  const diagnostic = formatCrashDiagnostic({ name: "N".repeat(50000), message: "m".repeat(50000), stack: "s".repeat(50000) });
  expect(diagnostic.name).toHaveLength(100);
  expect(diagnostic.message).toHaveLength(1000);
  expect(diagnostic.stack).toHaveLength(8000);
  const html = '<img src=x onerror="synthetic()"><script>synthetic()</script>';
  expect(redactCrashText(html)).toBe(html);
  expect(redactCrashText("Useful error: loading model, status=502" )).toBe("Useful error: loading model, status=502");
  const prefix = "x".repeat(940) + ' token="';
  const source = prefix + "OPAQUE_RETAINED_" + "s".repeat(200) + '" useful suffix ' + "z".repeat(2000);
  expect(source.indexOf("OPAQUE_RETAINED_")).toBeLessThan(1000);
  expect(source.lastIndexOf('"')).toBeGreaterThan(1000);
  const message = formatCrashDiagnostic({ message: source }).message;
  expect(message).toBe(("x".repeat(940) + " token=[redacted] useful suffix " + "z".repeat(2000)).slice(0, 1000));
  expect(message).toHaveLength(1000);
  expect(message).not.toContain("OPAQUE_RETAINED_");
});
