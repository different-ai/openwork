import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserSecretError, SECRET_KINDS, createBrowserSecrets, decidePausedRequest } from "./browser-secrets.mjs";

const SITE = "https://app.example";
const API = "https://api.example";
const OTHER = "https://other.example";
const TAB = "tab-1";
// Every value here is made up for the test.
const PLAIN = "fake-Passw0rd-123";
const AWKWARD = 'fake "quoted" \\ back/slash\nline ünïcödé ✓ & <b> \'x\' 100% a+b=c';

function store(options = {}) {
  const clock = { at: 1_000_000 };
  return { clock, secrets: createBrowserSecrets({ now: () => clock.at, ...options }) };
}
function seeded({ value = PLAIN, origins = [SITE], options = {}, origin = origins[0], tabId = TAB, ref = "e1", kind = "password" } = {}) {
  const { clock, secrets } = store(options);
  const secret = secrets.add({ sessionId: "s1", label: "Example login", kind, origins, value });
  const { placeholder } = secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId, origin, ref });
  return { clock, secrets, secret, placeholder, value };
}
const request = (extra = {}) => ({ tabId: TAB, url: `${SITE}/login`, method: "POST", resourceType: "XHR", bodyComplete: true, ...extra });
const jsonRequest = (payload, extra = {}) => request({ headers: { "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify(payload)), ...extra });
const multipart = (boundary, parts) => Buffer.concat([
  ...parts.map(({ headers, body }) => Buffer.concat([Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), Buffer.from(body), Buffer.from("\r\n")])),
  Buffer.from(`--${boundary}--\r\n`),
]);
const rejects = (run, code) => assert.throws(run, (error) => error instanceof BrowserSecretError && error.code === code && error.message.length > 0);
const state = (secrets, tabId = TAB) => secrets.status("s1", tabId).map(({ state, reason }) => reason ? `${state}:${reason}` : state);

test("kinds are password, code and token", () => {
  assert.deepEqual(SECRET_KINDS, ["password", "code", "token"]);
});

test("add returns a handle without the value and lists it for its conversation", () => {
  const { secrets } = store();
  const added = secrets.add({ sessionId: "s1", label: "  Example login  ", kind: "password", origins: [SITE, API, SITE], value: PLAIN });
  assert.match(added.secretRef, /^sec_[A-Za-z0-9]{22}$/);
  assert.deepEqual(added, { secretRef: added.secretRef, label: "Example login", kind: "password", origins: [SITE, API] });
  assert.deepEqual(secrets.list("s1"), [added]);
  assert.deepEqual(secrets.describe("s1", added.secretRef), added);
  assert.deepEqual(secrets.availableFor("s1", API), [{ secretRef: added.secretRef, label: "Example login", kind: "password" }]);
  assert.deepEqual(secrets.availableFor("s1", OTHER), []);
  assert.ok(!JSON.stringify([added, secrets.list("s1"), secrets.describe("s1", added.secretRef), secrets.availableFor("s1", SITE)]).includes(PLAIN));
  // A caller that edits what it was given cannot widen where the secret may go.
  secrets.describe("s1", added.secretRef).origins.push(OTHER);
  secrets.list("s1")[0].origins.push(OTHER);
  assert.deepEqual(secrets.describe("s1", added.secretRef).origins, [SITE, API]);
});

test("add refuses origins that are not exact https origins", () => {
  const { secrets } = store();
  const add = (origins) => () => secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins, value: PLAIN });
  for (const origin of ["http://app.example", "https://app.example/login", "https://app.example/", "https://APP.example", "https://app.example:443", "https://*.example",
    "app.example", "wss://app.example", "file:///tmp/a", "http://127.0.0.1:4010", "http://localhost:4010", "", 7, null]) {
    rejects(add([origin]), "invalid_secret");
  }
  rejects(add([]), "invalid_secret");
  rejects(add("https://app.example"), "invalid_secret");
  rejects(add(Array.from({ length: 11 }, (_unused, index) => `https://site${index}.example`)), "invalid_secret");
  assert.equal(add(Array.from({ length: 10 }, (_unused, index) => `https://site${index}.example`))().origins.length, 10);
  assert.deepEqual(add(["https://app.example:8443"])().origins, ["https://app.example:8443"]);
});

test("loopback http is an allowed origin only when the store was created for tests", () => {
  const loopback = store({ allowLoopbackHttp: true }).secrets;
  const add = (secrets, origin) => () => secrets.add({ sessionId: "s1", label: "Example", kind: "code", origins: [origin], value: PLAIN });
  assert.deepEqual(add(loopback, "http://127.0.0.1:4010")().origins, ["http://127.0.0.1:4010"]);
  assert.deepEqual(add(loopback, "http://localhost:4010")().origins, ["http://localhost:4010"]);
  rejects(add(loopback, "http://app.example"), "invalid_secret");
  rejects(add(loopback, "http://192.168.1.10:4010"), "invalid_secret");
  rejects(add(store().secrets, "http://127.0.0.1:4010"), "invalid_secret");
});

test("add refuses a value, label or kind out of bounds and never repeats what was typed", () => {
  const { secrets } = store();
  const add = (extra) => () => secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [SITE], value: PLAIN, ...extra });
  rejects(add({ value: "12345" }), "invalid_secret");
  rejects(add({ value: "x".repeat(4097) }), "invalid_secret");
  rejects(add({ value: 123456 }), "invalid_secret");
  rejects(add({ value: `fake-lone-surrogate-\ud800` }), "invalid_secret");
  rejects(add({ kind: "passphrase" }), "invalid_secret");
  rejects(add({ kind: undefined }), "invalid_secret");
  rejects(add({ label: "   " }), "invalid_secret");
  rejects(add({ label: "x".repeat(81) }), "invalid_secret");
  rejects(add({ label: `mine is ${PLAIN}` }), "invalid_secret");
  rejects(add({ sessionId: "" }), "invalid_secret");
  assert.equal(add({ value: "123456", kind: "code" })().kind, "code");
  assert.equal(add({ value: "x".repeat(4096), kind: "token", label: "x".repeat(80) })().kind, "token");
  // A secret pasted into the website box, or a refused secret, must not come back in the message.
  for (const attempt of [add({ origins: [`https://app.example/${PLAIN}`] }), add({ origins: [PLAIN] }), add({ value: PLAIN, label: `x ${PLAIN}` }), add({ value: `${PLAIN}\ud800` })]) {
    assert.throws(attempt, (error) => error instanceof BrowserSecretError && !error.message.includes(PLAIN) && !String(error.stack).includes(PLAIN));
  }
});

test("a conversation holds at most maxPerSession secrets", () => {
  const { secrets } = store({ maxPerSession: 2 });
  const add = (sessionId) => secrets.add({ sessionId, label: "Example", kind: "password", origins: [SITE], value: PLAIN });
  const first = add("s1");
  add("s1");
  rejects(() => add("s1"), "invalid_secret");
  assert.equal(add("s2").kind, "password");
  assert.equal(secrets.remove("s1", first.secretRef), true);
  assert.equal(add("s1").kind, "password");
  assert.equal(createBrowserSecrets().list("s1").length, 0);
});

test("another conversation cannot describe, list, issue, remove or read the status of a secret", () => {
  const { secrets, secret, placeholder } = seeded();
  assert.equal(secrets.describe("s2", secret.secretRef), null);
  assert.deepEqual(secrets.list("s2"), []);
  assert.deepEqual(secrets.availableFor("s2", SITE), []);
  rejects(() => secrets.issue({ sessionId: "s2", secretRef: secret.secretRef, tabId: "tab-2", origin: SITE, ref: "e1" }), "unknown_secret");
  assert.equal(secrets.remove("s2", secret.secretRef), false);
  assert.deepEqual(secrets.status("s2", TAB), []);
  secrets.clearSession("s2");
  assert.equal(secrets.live(TAB), true);
  assert.equal(secrets.rewrite(jsonRequest({ password: placeholder })).body.toString(), JSON.stringify({ password: PLAIN }));
});

test("issue refuses an unknown secret, a site the secret is not allowed on, and a missing field", () => {
  const { secrets, secret } = seeded();
  rejects(() => secrets.issue({ sessionId: "s1", secretRef: "sec_doesNotExist0000000000", tabId: TAB, origin: SITE, ref: "e2" }), "unknown_secret");
  rejects(() => secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: OTHER, ref: "e2" }), "secret_not_allowed_here");
  rejects(() => secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: `${SITE}/login`, ref: "e2" }), "secret_not_allowed_here");
  rejects(() => secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: "", origin: SITE, ref: "e2" }), "invalid_request");
  rejects(() => secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: undefined }), "invalid_request");
  assert.deepEqual(state(secrets), ["pending"]);
});

test("a placeholder is 32 random letters and digits, unrelated to the value", () => {
  const short = seeded({ value: "123456" });
  const long = seeded({ value: "x".repeat(4096) });
  const again = short.secrets.issue({ sessionId: "s1", secretRef: short.secret.secretRef, tabId: TAB, origin: SITE, ref: "e2" }).placeholder;
  for (const placeholder of [short.placeholder, long.placeholder, again]) assert.match(placeholder, /^[A-Za-z][A-Za-z0-9]{31}$/);
  assert.notEqual(short.placeholder, again);
  assert.notEqual(short.placeholder.slice(0, 8), long.placeholder.slice(0, 8));
});

test("rule 1: a tab without a live placeholder, and a request without one, continue untouched", () => {
  const { secrets, placeholder } = seeded();
  assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder }, { tabId: "tab-2" })), { action: "continue" });
  assert.deepEqual(secrets.rewrite({ tabId: "tab-2" }), { action: "continue" });
  assert.deepEqual(secrets.rewrite(undefined), { action: "continue" });
  assert.deepEqual(secrets.rewrite(request({ method: "GET", url: `${SITE}/app.js`, headers: { Accept: "*/*" } })), { action: "continue" });
  assert.deepEqual(secrets.rewrite(jsonRequest({ user: "someone" }, { method: "GET" })), { action: "continue" });
  // Text that only looks like a placeholder of this store is nobody's secret.
  const forged = `${placeholder.slice(0, 8)}${"A".repeat(24)}`;
  assert.deepEqual(secrets.rewrite(jsonRequest({ password: forged }, { method: "PUT", url: `${OTHER}/x` })), { action: "continue" });
  assert.deepEqual(state(secrets), ["pending"]);
});

test("rule 1: a placeholder issued for one tab is never swapped in another tab's request", () => {
  const { secrets, secret, placeholder } = seeded();
  const second = secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: "tab-2", origin: SITE, ref: "e1" }).placeholder;
  assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder }, { tabId: "tab-2" })), { action: "continue" });
  assert.equal(secrets.rewrite(jsonRequest({ password: second }, { tabId: "tab-2" })).body.toString(), JSON.stringify({ password: PLAIN }));
  assert.deepEqual(state(secrets, TAB), ["pending"]);
});

test("rule 2: a placeholder in the address, raw or percent-encoded, is never swapped", () => {
  for (const spell of [(text) => text, (text) => [...text].map((char) => `%${char.charCodeAt(0).toString(16)}`).join(""),
    (text) => encodeURIComponent([...text].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join(""))]) {
    const { secrets, placeholder } = seeded();
    assert.deepEqual(secrets.rewrite(request({ method: "GET", url: `${SITE}/login?password=${spell(placeholder)}` })), { action: "continue" });
    // The body of the same request is left alone too: it carries the placeholder only.
    assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder }, { url: `${SITE}/login/${spell(placeholder)}` })), { action: "continue" });
    assert.deepEqual(state(secrets), ["not_sent:in_url"]);
  }
});

test("rule 2: a placeholder in Referer is never swapped and nothing else in that request is", () => {
  const { secrets, placeholder } = seeded();
  const decision = secrets.rewrite(jsonRequest({ password: placeholder }, { headers: { "Content-Type": "application/json", Referer: `${SITE}/login?p=${placeholder}`, Authorization: `Bearer ${placeholder}` } }));
  assert.deepEqual(decision, { action: "continue" });
  assert.deepEqual(state(secrets), ["not_sent:in_url"]);
});

test("rule 3: a request to an origin the secret is not allowed for carries the placeholder only", () => {
  for (const url of [`${OTHER}/collect`, "http://app.example/login", "https://app.example:8443/login", "https://login.app.example/", "https://app.example.other.example/login"]) {
    const { secrets, placeholder } = seeded();
    assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder }, { url })), { action: "continue" });
    assert.deepEqual(secrets.rewrite(request({ url, method: "GET", headers: { Authorization: `Bearer ${placeholder}` } })), { action: "continue" });
    assert.deepEqual(state(secrets), ["not_sent:other_origin"]);
  }
});

test("rule 3: WebSocket requests are never swapped, whatever their address", () => {
  for (const extra of [{ url: "wss://app.example/socket" }, { url: "ws://app.example/socket" }, { resourceType: "WebSocket" }]) {
    const { secrets, placeholder } = seeded();
    assert.deepEqual(secrets.rewrite(request({ method: "GET", headers: { "Sec-WebSocket-Protocol": placeholder }, ...extra })), { action: "continue" });
    assert.deepEqual(state(secrets), ["not_sent:other_origin"]);
  }
});

test("rule 3: a secret allowed for two origins is swapped for either and reported with where it went", () => {
  const { secrets, secret, placeholder } = seeded({ origins: [SITE, API] });
  assert.equal(secrets.rewrite(jsonRequest({ password: placeholder }, { url: `${API}/session`, headers: { "content-type": "application/json", Origin: SITE } })).body.toString(), JSON.stringify({ password: PLAIN }));
  assert.deepEqual(secrets.status("s1", TAB), [{ secretRef: secret.secretRef, ref: "e1", state: "sent", sentTo: [API] }]);
});

test("rule 3: loopback http is swapped only under allowLoopbackHttp", () => {
  const local = "http://127.0.0.1:4010";
  const { secrets, placeholder } = seeded({ origins: [local], options: { allowLoopbackHttp: true } });
  assert.equal(secrets.rewrite(jsonRequest({ password: placeholder }, { url: `${local}/login` })).body.toString(), JSON.stringify({ password: PLAIN }));
  assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder }, { url: "http://127.0.0.1:4011/login" })), { action: "continue" });
});

test("rule 4: JSON bodies get the JSON-escaped value, in values and keys, at any depth", () => {
  for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8", "application/vnd.api+json", "application/problem+json"]) {
    const { secrets, placeholder, value } = seeded({ value: AWKWARD });
    const payload = { user: "someone", password: placeholder, nested: [{ [`key-${placeholder}`]: `Basic someone:${placeholder}` }, 7, null, true] };
    const text = JSON.stringify(payload, null, 2).replace('"nested"', `"__proto__": {"again": "${placeholder}"}, "nested"`);
    const decision = secrets.rewrite(request({ headers: { "Content-Type": contentType }, body: Buffer.from(text) }));
    assert.equal(decision.action, "continue");
    assert.equal(decision.headers, undefined);
    assert.equal(decision.body.toString(), text.replaceAll(placeholder, JSON.stringify(value).slice(1, -1)));
    const parsed = JSON.parse(decision.body.toString());
    assert.equal(parsed.password, value);
    assert.equal(parsed.nested[0][`key-${value}`], `Basic someone:${value}`);
    assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, "__proto__").value, { again: value });
    assert.deepEqual(state(secrets), ["sent"]);
  }
});

test("rule 4: a JSON value with dollar signs is inserted literally", () => {
  const value = "fake-$&-$1-$$-$`-$'-value";
  const { secrets, placeholder } = seeded({ value });
  assert.deepEqual(JSON.parse(secrets.rewrite(jsonRequest({ password: placeholder })).body.toString()), { password: value });
  const form = secrets.rewrite(request({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(`password=${placeholder}`) }));
  assert.equal(new URLSearchParams(form.body.toString()).get("password"), value);
  const header = secrets.rewrite(request({ method: "GET", headers: { Authorization: `Bearer ${placeholder}` } }));
  assert.equal(header.headers.Authorization, `Bearer ${value}`);
});

test("rule 4: a JSON string that is itself an encoding fails the request", () => {
  for (const inner of [(placeholder) => JSON.stringify({ password: placeholder }), (placeholder) => JSON.stringify([placeholder]), (placeholder) => JSON.stringify(placeholder)]) {
    const { secrets, placeholder } = seeded({ value: AWKWARD });
    assert.deepEqual(secrets.rewrite(jsonRequest({ payload: inner(placeholder) })), { action: "fail" });
    assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
  }
});

test("rule 4: a body that claims JSON and is not fails the request", () => {
  for (const body of [(placeholder) => `{"password": "${placeholder}"`, (placeholder) => `password=${placeholder}`, (placeholder) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`{"p":"${placeholder}"}`)]),
    (placeholder) => `\ufeff{"p":"${placeholder}"}`]) {
    const { secrets, placeholder } = seeded();
    assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": "application/json" }, body: Buffer.from(body(placeholder)) })), { action: "fail" });
    assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
  }
});

test("rule 4: form bodies get exactly what URLSearchParams would send", () => {
  const { secrets, placeholder, value } = seeded({ value: AWKWARD });
  const before = new URLSearchParams([["user", "some one&co"], ["password", placeholder], [`f-${placeholder}`, `x ${placeholder} y`], ["empty", ""]]).toString();
  const decision = secrets.rewrite(request({ headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: Buffer.from(before) }));
  assert.equal(decision.action, "continue");
  assert.equal(decision.body.toString(), new URLSearchParams([["user", "some one&co"], ["password", value], [`f-${value}`, `x ${value} y`], ["empty", ""]]).toString());
  assert.deepEqual([...new URLSearchParams(decision.body.toString())], [["user", "some one&co"], ["password", value], [`f-${value}`, `x ${value} y`], ["empty", ""]]);
  assert.match(decision.body.toString(), /a%2Bb%3Dc/);
  assert.deepEqual(state(secrets), ["sent"]);
});

test("rule 4: a form field that is itself JSON fails the request", () => {
  const { secrets, placeholder } = seeded({ value: AWKWARD });
  const body = new URLSearchParams([["payload", JSON.stringify({ password: placeholder })]]).toString();
  assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(body) })), { action: "fail" });
});

test("rule 4: multipart bodies are swapped in a part body, byte for byte", () => {
  const value = 'fake "quoted" ünïcödé ✓ & 100% a+b=c --';
  const { secrets, placeholder } = seeded({ value });
  const boundary = "----WebKitFormBoundaryAbCdEfGhIjKlMnOp";
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x0d, 0x0a, 0x2d, 0x2d]);
  const parts = (secret) => [
    { headers: 'Content-Disposition: form-data; name="user"', body: "someone" },
    { headers: 'Content-Disposition: form-data; name="password"', body: secret },
    { headers: 'Content-Disposition: form-data; name="note"\r\nContent-Type: text/plain; charset=UTF-8', body: `twice ${secret} ${secret}` },
    { headers: 'Content-Disposition: form-data; name="empty"', body: "" },
    { headers: 'Content-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png', body: binary },
  ];
  const decision = secrets.rewrite(request({ headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: multipart(boundary, parts(placeholder)) }));
  assert.equal(decision.action, "continue");
  assert.equal(decision.headers, undefined);
  assert.ok(decision.body.equals(multipart(boundary, parts(value))));
  assert.deepEqual(state(secrets), ["sent"]);
});

test("rule 4: multipart is refused when the placeholder is in a part's headers or outside a part body", () => {
  const boundary = "----fakeBoundary1234567890";
  const type = { "Content-Type": `multipart/form-data; boundary="${boundary}"` };
  const cases = [
    (placeholder) => multipart(boundary, [{ headers: `Content-Disposition: form-data; name="${placeholder}"`, body: "x" }]),
    (placeholder) => multipart(boundary, [{ headers: `Content-Disposition: form-data; name="f"; filename="${placeholder}.txt"`, body: placeholder }]),
    (placeholder) => Buffer.concat([multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"', body: "x" }]), Buffer.from(placeholder)]),
    (placeholder) => Buffer.concat([Buffer.from(`${placeholder}\r\n`), multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"', body: "x" }])]),
    (placeholder) => multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"\r\nContent-Type: application/json', body: `{"p":"${placeholder}"}` }]),
    (placeholder) => multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"', body: `{"p":"${placeholder}"}` }]),
    (placeholder) => multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"\r\nContent-Transfer-Encoding: base64', body: placeholder }]),
    (placeholder) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\n${placeholder}`),
  ];
  for (const body of cases) {
    const { secrets, placeholder } = seeded();
    assert.deepEqual(secrets.rewrite(request({ headers: type, body: body(placeholder) })), { action: "fail" });
    assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
  }
  const { secrets, placeholder } = seeded();
  assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": "multipart/form-data" }, body: multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"', body: placeholder }]) })), { action: "fail" });
});

test("rule 4: multipart is refused for a value with a line break or the boundary", () => {
  const boundary = "----fakeBoundary1234567890";
  for (const value of ["fake-line\r\nbreak", "fake-line\nbreak", "fake-carriage\rreturn", `fake-----fakeBoundary1234567890-value`]) {
    const { secrets, placeholder } = seeded({ value });
    const body = multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="password"', body: placeholder }]);
    assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body })), { action: "fail" });
    assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
  }
});

test("rule 4: text/plain that is JSON is rewritten as JSON, and as raw text otherwise", () => {
  const json = seeded({ value: AWKWARD });
  const asJson = json.secrets.rewrite(request({ headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: Buffer.from(` {"password":"${json.placeholder}"}`) }));
  assert.deepEqual(JSON.parse(asJson.body.toString()), { password: AWKWARD });
  const array = seeded({ value: AWKWARD });
  assert.deepEqual(JSON.parse(array.secrets.rewrite(request({ headers: { "Content-Type": "text/plain" }, body: Buffer.from(`["${array.placeholder}"]`) })).body.toString()), [AWKWARD]);
  const raw = seeded({ value: AWKWARD });
  const asText = raw.secrets.rewrite(request({ headers: { "Content-Type": "text/plain" }, body: Buffer.from(`password=${raw.placeholder}\r\nuser=ünï\r\n`) }));
  assert.equal(asText.body.toString(), `password=${AWKWARD}\r\nuser=ünï\r\n`);
  const broken = seeded({ value: AWKWARD });
  assert.equal(broken.secrets.rewrite(request({ headers: { "Content-Type": "text/plain" }, body: Buffer.from(`{"password":"${broken.placeholder}"`) })).body.toString(), `{"password":"${AWKWARD}"`);
  const nested = seeded({ value: AWKWARD });
  assert.deepEqual(nested.secrets.rewrite(request({ headers: { "Content-Type": "text/plain" }, body: Buffer.from(JSON.stringify({ payload: JSON.stringify({ p: nested.placeholder }) })) })), { action: "fail" });
});

test("rule 4: an unknown, missing or non-UTF-8 content type fails the request", () => {
  for (const headers of [{ "Content-Type": "application/octet-stream" }, { "Content-Type": "application/xml" }, { "Content-Type": "text/html" }, { "Content-Type": "application/graphql" }, {}, undefined,
    { "Content-Type": "application/json; charset=utf-16" }, { "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1" }, { "Content-Type": "text/plain; charset=windows-1252" }]) {
    const { secrets, placeholder } = seeded();
    assert.deepEqual(secrets.rewrite(request({ headers, body: Buffer.from(`{"password":"${placeholder}"}`) })), { action: "fail" });
    assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
  }
});

test("rule 4: a body that was not read whole fails when the placeholder is visible and continues when it is not", () => {
  const { secrets, placeholder } = seeded();
  assert.deepEqual(secrets.rewrite(jsonRequest({ user: "someone" }, { bodyComplete: false })), { action: "continue" });
  assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": "application/json" }, bodyComplete: false })), { action: "continue" });
  assert.deepEqual(state(secrets), ["pending"]);
  assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder }, { bodyComplete: false })), { action: "fail" });
  assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
});

test("rule 4: a 2 MB body is rewritten whole and a 2 MB body without a placeholder is passed through", () => {
  const { secrets, placeholder } = seeded({ value: AWKWARD });
  const filler = Array.from({ length: 20_000 }, (_unused, index) => ({ id: index, text: "lorem ipsum dolor sit amet ".repeat(4) }));
  const payload = { filler, password: placeholder, tail: filler.slice(0, 10) };
  const body = Buffer.from(JSON.stringify(payload));
  assert.ok(body.length > 2_000_000);
  const started = performance.now();
  const decision = secrets.rewrite(request({ headers: { "Content-Type": "application/json" }, body }));
  assert.deepEqual(JSON.parse(decision.body.toString()), { ...payload, password: AWKWARD });
  assert.deepEqual(secrets.rewrite(jsonRequest({ filler })), { action: "continue" });
  const raw = Buffer.concat([Buffer.alloc(2_000_000, "x"), Buffer.from(placeholder), Buffer.alloc(1000, "y")]);
  const text = secrets.rewrite(request({ headers: { "Content-Type": "text/plain" }, body: raw }));
  assert.equal(text.body.length, raw.length - placeholder.length + Buffer.byteLength(AWKWARD));
  assert.ok(performance.now() - started < 5000);
});

test("rule 5: a header value is swapped in place and the whole list goes back in its order", () => {
  const { secrets, placeholder, value } = seeded({ kind: "token" });
  const headers = { accept: "application/json", "X-Api-Key": placeholder, Authorization: `Bearer ${placeholder}`, "Content-Type": "application/json", "Content-Length": "17", Cookie: `sid=${placeholder}`, "user-agent": "test" };
  const decision = secrets.rewrite(request({ headers, body: Buffer.from(JSON.stringify({ user: "someone" })) }));
  assert.equal(decision.action, "continue");
  assert.equal(decision.body, undefined);
  assert.deepEqual(Object.entries(decision.headers), [["accept", "application/json"], ["X-Api-Key", value], ["Authorization", `Bearer ${value}`], ["Content-Type", "application/json"], ["Cookie", `sid=${placeholder}`], ["user-agent", "test"]]);
  assert.deepEqual(state(secrets), ["sent"]);
  // The request the host was given is not edited.
  assert.equal(headers.Authorization, `Bearer ${placeholder}`);
});

test("rule 5: a placeholder only in Cookie, Origin or Host is left alone", () => {
  const { secrets, placeholder } = seeded();
  assert.deepEqual(secrets.rewrite(request({ method: "GET", headers: { Cookie: `sid=${placeholder}`, Host: placeholder } })), { action: "continue" });
  assert.deepEqual(state(secrets), ["pending"]);
});

test("rule 5: a value that cannot sit in a header fails the request", () => {
  for (const value of ["fake-line\nbreak", "fake-carriage\rreturn", "fake-nul\0value", "fake-snowman-☃-value", "fake-emoji-😀-value"]) {
    const { secrets, placeholder } = seeded({ value });
    assert.deepEqual(secrets.rewrite(request({ method: "GET", headers: { Authorization: `Bearer ${placeholder}` } })), { action: "fail" });
    assert.deepEqual(state(secrets), ["not_sent:unsupported_encoding"]);
    // The same value is fine in a JSON body.
    assert.deepEqual(JSON.parse(secrets.rewrite(jsonRequest({ password: placeholder })).body.toString()), { password: value });
  }
  const latin = seeded({ value: "fake-latin-é-value" });
  assert.equal(latin.secrets.rewrite(request({ method: "GET", headers: { Authorization: latin.placeholder } })).headers.Authorization, "fake-latin-é-value");
});

test("rules 5 and 6: header and body are swapped together, without a Content-Length", () => {
  const { secrets, placeholder, value } = seeded({ value: AWKWARD.replace("\n", " ").replace("ünïcödé ✓", "plain") });
  const decision = secrets.rewrite(jsonRequest({ password: placeholder }, { headers: { "content-length": "99", "Content-Type": "application/json", "X-Token": placeholder } }));
  assert.deepEqual(decision.headers, { "Content-Type": "application/json", "X-Token": value });
  assert.deepEqual(JSON.parse(decision.body.toString()), { password: value });
  const bodyOnly = secrets.rewrite(jsonRequest({ password: placeholder }, { headers: { "Content-Length": "99", "Content-Type": "application/json" } }));
  assert.equal(bodyOnly.headers, undefined);
});

test("rule 7: each redirect hop is judged on its own address", () => {
  const { secrets, placeholder } = seeded();
  const body = Buffer.from(JSON.stringify({ password: placeholder }));
  const headers = { "Content-Type": "application/json" };
  assert.equal(secrets.rewrite(request({ headers, body })).body.toString(), JSON.stringify({ password: PLAIN }));
  assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/moved`, headers, body })), { action: "continue" });
  assert.deepEqual(secrets.rewrite(request({ url: `${SITE}/moved?p=${placeholder}`, headers, body })), { action: "continue" });
  assert.equal(secrets.rewrite(request({ url: `${SITE}/back`, headers, body })).body.toString(), JSON.stringify({ password: PLAIN }));
  assert.deepEqual(secrets.status("s1", TAB).map(({ state, sentTo }) => [state, sentTo]), [["sent", [SITE]]]);
});

test("rule 7: a redirect that replays the rewritten body to an origin the secret is not allowed for is blocked", () => {
  const value = 'fake "quoted" & 100% a+b=c';
  for (const [contentType, text] of [["application/json", (secret) => JSON.stringify({ password: secret })], ["application/x-www-form-urlencoded", (secret) => `password=${secret}`], ["text/plain", (secret) => `password=${secret}`]]) {
    const { secrets, placeholder } = seeded({ value, origins: [SITE, API] });
    const headers = { "Content-Type": contentType, Origin: SITE };
    // Before anything was sent, the same characters in a request elsewhere are the page's own business.
    assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/collect`, headers, body: Buffer.from(`note=${value}`) })), { action: "continue" });
    const rewritten = secrets.rewrite(request({ headers, body: Buffer.from(text(placeholder)) })).body;
    assert.ok(rewritten.includes(contentType === "text/plain" ? value : contentType === "application/json" ? JSON.stringify(value).slice(1, -1) : new URLSearchParams([["", value]]).toString().slice(1)));
    // Chromium sends the rewritten body on to the redirect target.
    assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/collect`, headers, body: rewritten })), { action: "fail" });
    assert.deepEqual(secrets.rewrite(request({ url: "http://app.example/login", headers, body: rewritten })), { action: "fail" });
    assert.deepEqual(secrets.rewrite(request({ url: "wss://app.example/socket", method: "GET", headers: { "Sec-WebSocket-Protocol": value } })), { action: "fail" });
    assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/collect`, method: "GET", headers: { "X-Token": value } })), { action: "fail" });
    assert.deepEqual(secrets.rewrite(request({ url: "not an address", headers, body: rewritten })), { action: "fail" });
    // The same body may follow a redirect to another origin of that secret, and other requests go on.
    assert.deepEqual(secrets.rewrite(request({ url: `${API}/session`, headers, body: rewritten })), { action: "continue" });
    assert.deepEqual(secrets.rewrite(request({ url: `${SITE}/again`, headers, body: rewritten })), { action: "continue" });
    assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/collect`, headers, body: Buffer.from(JSON.stringify({ event: "submit" })) })), { action: "continue" });
    assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/pixel.gif`, method: "GET", headers: { Accept: "image/*" } })), { action: "continue" });
    assert.deepEqual(state(secrets), ["sent"]);
    // Once the placeholder has expired the host no longer intercepts the tab.
    secrets.tabClosed(TAB);
    assert.deepEqual(secrets.rewrite(request({ url: `${OTHER}/collect`, headers, body: rewritten })), { action: "continue" });
  }
});

test("rule 8: a failure inside the decision fails the request and nothing is thrown", () => {
  const { secrets, placeholder } = seeded();
  const throwing = { get "Content-Type"() { throw new Error("boom"); } };
  assert.deepEqual(secrets.rewrite(request({ headers: throwing, body: Buffer.from(placeholder) })), { action: "fail" });
  assert.deepEqual(secrets.rewrite({ tabId: TAB }), { action: "fail" });
  assert.deepEqual(secrets.rewrite({ tabId: TAB, url: 5 }), { action: "fail" });
  let nested = `"${placeholder}"`;
  nested = `${"[".repeat(100_000)}${nested}${"]".repeat(100_000)}`;
  assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": "application/json" }, body: Buffer.from(nested) })), { action: "fail" });
  assert.equal(secrets.rewrite(jsonRequest({ password: placeholder })).body.toString(), JSON.stringify({ password: PLAIN }));
});

test("two secrets in one request: each is swapped only where it is allowed", () => {
  const { secrets } = store();
  const here = secrets.add({ sessionId: "s1", label: "Here", kind: "password", origins: [SITE], value: "fake-allowed-here-1" });
  const elsewhere = secrets.add({ sessionId: "s1", label: "Elsewhere", kind: "token", origins: [SITE, OTHER], value: "fake-allowed-there-2" });
  const narrow = secrets.add({ sessionId: "s1", label: "Narrow", kind: "code", origins: [API, SITE], value: "fake-narrow-3" });
  const first = secrets.issue({ sessionId: "s1", secretRef: here.secretRef, tabId: TAB, origin: SITE, ref: "e1" }).placeholder;
  const second = secrets.issue({ sessionId: "s1", secretRef: elsewhere.secretRef, tabId: TAB, origin: SITE, ref: "e2" }).placeholder;
  const third = secrets.issue({ sessionId: "s1", secretRef: narrow.secretRef, tabId: TAB, origin: SITE, ref: "e3" }).placeholder;
  // Sent to the other origin: only the secret allowed there becomes a value; the others stay placeholders.
  const mixed = secrets.rewrite(jsonRequest({ a: first, b: second, c: third, both: `${first}:${second}` }, { url: `${OTHER}/collect`, headers: { "Content-Type": "application/json", "X-A": first, "X-B": second } }));
  assert.deepEqual(JSON.parse(mixed.body.toString()), { a: first, b: "fake-allowed-there-2", c: third, both: `${first}:fake-allowed-there-2` });
  assert.deepEqual(mixed.headers, { "Content-Type": "application/json", "X-A": first, "X-B": "fake-allowed-there-2" });
  assert.ok(!mixed.body.includes("fake-allowed-here-1") && !mixed.body.includes("fake-narrow-3"));
  assert.deepEqual(secrets.status("s1", TAB), [
    { secretRef: here.secretRef, ref: "e1", state: "not_sent", reason: "other_origin" },
    { secretRef: elsewhere.secretRef, ref: "e2", state: "sent", sentTo: [OTHER] },
    { secretRef: narrow.secretRef, ref: "e3", state: "not_sent", reason: "other_origin" },
  ]);
  // All allowed: all swapped in one pass.
  const all = secrets.rewrite(jsonRequest({ a: first, b: second, c: third }));
  assert.deepEqual(JSON.parse(all.body.toString()), { a: "fake-allowed-here-1", b: "fake-allowed-there-2", c: "fake-narrow-3" });
  // One of them in the address: nothing in that request is swapped.
  assert.deepEqual(secrets.rewrite(jsonRequest({ a: first, b: second }, { url: `${SITE}/login?c=${third}` })), { action: "continue" });
  // An allowed value that cannot be encoded fails the request rather than sending half of it.
  assert.deepEqual(secrets.rewrite(request({ headers: { "Content-Type": "application/octet-stream", "X-B": second }, body: Buffer.from(first) })), { action: "fail" });
});

test("status: pending, then sent with the origins that received the value", () => {
  const { secrets, secret, placeholder } = seeded({ origins: [SITE, API] });
  assert.deepEqual(secrets.status("s1", TAB), [{ secretRef: secret.secretRef, ref: "e1", state: "pending" }]);
  secrets.rewrite(jsonRequest({ password: placeholder }));
  secrets.rewrite(jsonRequest({ password: placeholder }, { url: `${API}/session` }));
  secrets.rewrite(jsonRequest({ password: placeholder }));
  assert.deepEqual(secrets.status("s1", TAB), [{ secretRef: secret.secretRef, ref: "e1", state: "sent", sentTo: [SITE, API] }]);
  // Later skips do not undo a delivery.
  secrets.rewrite(jsonRequest({ password: placeholder }, { url: `${OTHER}/collect` }));
  secrets.rewrite(jsonRequest({ user: "someone" }));
  assert.equal(secrets.status("s1", TAB)[0].state, "sent");
  assert.ok(!JSON.stringify(secrets.status("s1", TAB)).includes(placeholder));
  assert.ok(!JSON.stringify(secrets.status("s1", TAB)).includes(PLAIN));
  assert.deepEqual(secrets.status("s1", "tab-2"), []);
});

test("status: after the agent acts, a request with a body to an allowed origin that does not carry the placeholder is left_without_secret", () => {
  const { secrets, placeholder } = seeded();
  secrets.noteAction(TAB);
  secrets.rewrite(request({ method: "GET", url: `${SITE}/app.js` }));
  secrets.rewrite(jsonRequest({ user: "someone" }, { method: "HEAD" }));
  secrets.rewrite(jsonRequest({ user: "someone" }, { url: `${OTHER}/collect` }));
  secrets.rewrite(jsonRequest({ user: "someone" }, { resourceType: "Ping" }));
  secrets.rewrite(request({ headers: { "Content-Type": "application/json" }, body: Buffer.alloc(0) }));
  secrets.rewrite(jsonRequest({ user: "someone" }, { bodyComplete: false }));
  assert.deepEqual(state(secrets), ["pending"]);
  secrets.rewrite(jsonRequest({ user: "someone", passwordHash: "0f0f0f" }));
  assert.deepEqual(state(secrets), ["not_sent:left_without_secret"]);
  secrets.rewrite(jsonRequest({ password: placeholder }));
  assert.deepEqual(state(secrets), ["sent"]);
});

test("status: what the page sends before the agent clicks or presses a key is never left_without_secret", () => {
  const { secrets, secret, placeholder } = seeded();
  secrets.rewrite(jsonRequest({ event: "field_changed" }));
  secrets.rewrite(jsonRequest({ event: "heartbeat" }));
  assert.deepEqual(state(secrets), ["pending"]);
  // An action in another tab says nothing about this one.
  secrets.noteAction("tab-2");
  secrets.rewrite(jsonRequest({ event: "heartbeat" }));
  assert.deepEqual(state(secrets), ["pending"]);
  secrets.noteAction(TAB);
  assert.deepEqual(state(secrets), ["pending"]);
  secrets.rewrite(jsonRequest({ passwordHash: "0f0f0f" }));
  assert.deepEqual(state(secrets), ["not_sent:left_without_secret"]);
  // A placeholder entered after that action waits for an action of its own.
  secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e2" });
  secrets.rewrite(jsonRequest({ event: "heartbeat" }));
  assert.deepEqual(state(secrets), ["not_sent:left_without_secret", "pending"]);
  assert.ok(!JSON.stringify(secrets.status("s1", TAB)).includes(placeholder));
});

test("status: left_without_secret is judged on the requests that follow the latest click or key", () => {
  const { secrets, placeholder } = seeded();
  // A first step of a sign-in form posts the user name alone.
  secrets.noteAction(TAB);
  secrets.rewrite(jsonRequest({ user: "someone" }));
  assert.deepEqual(state(secrets), ["not_sent:left_without_secret"]);
  secrets.noteAction(TAB);
  assert.deepEqual(state(secrets), ["pending"]);
  secrets.rewrite(jsonRequest({ password: placeholder }));
  assert.deepEqual(state(secrets), ["sent"]);
  // Once sent, a later request without it changes nothing.
  secrets.noteAction(TAB);
  secrets.rewrite(jsonRequest({ user: "someone" }));
  assert.deepEqual(state(secrets), ["sent"]);
});

test("noteAction on a tab without placeholders, or after they ended, does nothing", () => {
  const { secrets } = store();
  secrets.noteAction(TAB);
  secrets.noteAction(undefined);
  assert.deepEqual(secrets.status("s1", TAB), []);
  const held = seeded();
  held.secrets.tabClosed(TAB);
  held.secrets.noteAction(TAB);
  held.secrets.rewrite(jsonRequest({ user: "someone" }));
  assert.deepEqual(state(held.secrets), ["not_sent:expired"]);
});

test("status: a changed document lets requests in flight finish, then the placeholder expires", () => {
  const { secrets, clock, placeholder } = seeded({ options: { lingerMs: 15_000, placeholderTtlMs: 300_000 } });
  secrets.documentChanged(TAB);
  secrets.documentChanged("tab-unknown");
  clock.at += 14_999;
  assert.equal(secrets.live(TAB), true);
  assert.deepEqual(state(secrets), ["pending"]);
  // A second navigation does not extend the first one's grace period.
  secrets.documentChanged(TAB);
  clock.at += 1;
  assert.equal(secrets.live(TAB), false);
  assert.deepEqual(state(secrets), ["not_sent:expired"]);
  assert.deepEqual(secrets.rewrite(jsonRequest({ password: placeholder })), { action: "continue" });
  clock.at += 599_999;
  assert.deepEqual(state(secrets), ["not_sent:expired"]);
  clock.at += 1;
  assert.deepEqual(secrets.status("s1", TAB), []);
});

test("status: a form post in flight when the document changes still gets the value and stays sent after expiry", () => {
  const { secrets, clock, placeholder } = seeded();
  secrets.documentChanged(TAB);
  clock.at += 5000;
  assert.equal(secrets.rewrite(request({ resourceType: "Document", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(`password=${placeholder}`) })).body.toString(), `password=${PLAIN}`);
  clock.at += 20_000;
  assert.equal(secrets.live(TAB), false);
  assert.deepEqual(state(secrets), ["sent"]);
});

test("status: a placeholder nobody used expires after its time to live", () => {
  const { secrets, clock, placeholder } = seeded({ options: { placeholderTtlMs: 300_000 } });
  clock.at += 299_999;
  assert.equal(secrets.rewrite(jsonRequest({ password: placeholder })).action, "continue");
  assert.ok(secrets.rewrite(jsonRequest({ password: placeholder })).body);
  const unused = seeded({ options: { placeholderTtlMs: 300_000 } });
  unused.clock.at += 300_000;
  assert.deepEqual(unused.secrets.rewrite(jsonRequest({ password: unused.placeholder })), { action: "continue" });
  assert.deepEqual(state(unused.secrets), ["not_sent:expired"]);
  assert.equal(unused.secrets.live(TAB), false);
});

test("status: removing a secret, closing its tab or losing interception revokes at once", () => {
  const removed = seeded();
  assert.equal(removed.secrets.remove("s1", removed.secret.secretRef), true);
  assert.equal(removed.secrets.remove("s1", removed.secret.secretRef), false);
  assert.equal(removed.secrets.live(TAB), false);
  assert.deepEqual(state(removed.secrets), ["not_sent:removed"]);
  assert.deepEqual(removed.secrets.rewrite(jsonRequest({ password: removed.placeholder })), { action: "continue" });
  assert.equal(removed.secrets.describe("s1", removed.secret.secretRef), null);

  const closed = seeded();
  closed.secrets.tabClosed(TAB);
  assert.equal(closed.secrets.live(TAB), false);
  assert.deepEqual(state(closed.secrets), ["not_sent:expired"]);
  assert.deepEqual(closed.secrets.rewrite(jsonRequest({ password: closed.placeholder })), { action: "continue" });
  assert.deepEqual(closed.secrets.list("s1").length, 1);

  const lost = seeded();
  lost.secrets.interceptionLost(TAB);
  assert.equal(lost.secrets.live(TAB), false);
  assert.deepEqual(state(lost.secrets), ["not_sent:interception_lost"]);
  assert.deepEqual(lost.secrets.rewrite(jsonRequest({ password: lost.placeholder })), { action: "continue" });

  const session = seeded();
  session.secrets.clearSession("s1");
  assert.equal(session.secrets.live(TAB), false);
  assert.deepEqual(state(session.secrets), ["not_sent:removed"]);
  assert.deepEqual(session.secrets.list("s1"), []);

  const all = seeded();
  all.secrets.clear();
  assert.equal(all.secrets.live(TAB), false);
  assert.deepEqual(all.secrets.status("s1", TAB), []);
  assert.deepEqual(all.secrets.list("s1"), []);
  assert.deepEqual(all.secrets.rewrite(jsonRequest({ password: all.placeholder })), { action: "continue" });
  assert.equal(all.secrets.redactText(`x ${PLAIN} y`), `x ${PLAIN} y`);
});

test("a new placeholder for the same field retires the previous one", () => {
  const { secrets, secret, placeholder } = seeded();
  const events = [];
  secrets.onLiveChange((tabId, live) => events.push([tabId, live]));
  const next = secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e1" }).placeholder;
  assert.notEqual(next, placeholder);
  assert.deepEqual(secrets.status("s1", TAB), [{ secretRef: secret.secretRef, ref: "e1", state: "pending" }]);
  const decision = secrets.rewrite(jsonRequest({ old: placeholder, password: next }));
  assert.deepEqual(JSON.parse(decision.body.toString()), { old: placeholder, password: PLAIN });
  assert.deepEqual(secrets.rewrite(jsonRequest({ old: placeholder }, { method: "GET" })), { action: "continue" });
  assert.deepEqual(events, []);
  // Another field of the same tab keeps its own placeholder.
  const other = secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e2" }).placeholder;
  assert.deepEqual(JSON.parse(secrets.rewrite(jsonRequest({ a: next, b: other })).body.toString()), { a: PLAIN, b: PLAIN });
  assert.equal(secrets.status("s1", TAB).length, 2);
});

test("a field of a new document does not retire the previous document's placeholder while it lingers", () => {
  const { secrets, secret, placeholder } = seeded();
  secrets.documentChanged(TAB);
  const next = secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e1" }).placeholder;
  assert.deepEqual(JSON.parse(secrets.rewrite(jsonRequest({ before: placeholder, after: next })).body.toString()), { before: PLAIN, after: PLAIN });
  assert.equal(secrets.status("s1", TAB).length, 2);
});

test("live and onLiveChange follow the tab's placeholders", () => {
  const { secrets, clock } = store({ placeholderTtlMs: 1000 });
  const secret = secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [SITE], value: PLAIN });
  const events = [];
  const stop = secrets.onLiveChange((tabId, live) => events.push([tabId, live]));
  secrets.onLiveChange(() => { throw new Error("a listener that fails"); });
  assert.equal(secrets.live(TAB), false);
  secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e1" });
  secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e2" });
  secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: "tab-2", origin: SITE, ref: "e1" });
  assert.deepEqual(events, [[TAB, true], ["tab-2", true]]);
  assert.equal(secrets.live(TAB), true);
  secrets.tabClosed("tab-2");
  assert.deepEqual(events.splice(0), [[TAB, true], ["tab-2", true], ["tab-2", false]]);
  // Expiry is decided on read, from the clock alone.
  clock.at += 1000;
  assert.deepEqual(events, []);
  assert.equal(secrets.live(TAB), false);
  assert.deepEqual(events.splice(0), [[TAB, false]]);
  secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e1" });
  secrets.remove("s1", secret.secretRef);
  assert.deepEqual(events.splice(0), [[TAB, true], [TAB, false]]);
  stop();
  const again = secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [SITE], value: PLAIN });
  secrets.issue({ sessionId: "s1", secretRef: again.secretRef, tabId: TAB, origin: SITE, ref: "e1" });
  secrets.clear();
  assert.deepEqual(events, []);
});

test("a host that only listens hears about expiry without reading", async () => {
  const secrets = createBrowserSecrets({ placeholderTtlMs: 300_000, lingerMs: 30 });
  const secret = secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [SITE], value: PLAIN });
  const ended = new Promise((resolve) => secrets.onLiveChange((tabId, live) => { if (!live) resolve(tabId); }));
  secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e1" });
  secrets.documentChanged(TAB);
  const keepAlive = setTimeout(() => {}, 5000);
  assert.equal(await ended, TAB);
  clearTimeout(keepAlive);
  assert.deepEqual(state(secrets), ["not_sent:expired"]);
});

test("a store with live placeholders does not keep the process alive", () => {
  const module = fileURLToPath(new URL("./browser-secrets.mjs", import.meta.url));
  const script = `import { createBrowserSecrets } from ${JSON.stringify(module)};
    const secrets = createBrowserSecrets();
    const secret = secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: ["https://app.example"], value: "fake-Passw0rd-123" });
    secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: "tab-1", origin: "https://app.example", ref: "e1" });
    secrets.documentChanged("tab-1");
    console.log(secrets.live("tab-1"));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "true");
});

const encodings = (value) => ({
  raw: [value],
  uri: [encodeURIComponent(value), encodeURI(value)],
  uriLowerHex: [encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (pair) => pair.toLowerCase())],
  form: [new URLSearchParams([["", value]]).toString().slice(1)],
  everyByte: [[...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join(""), [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")],
  doubleUri: [encodeURIComponent(encodeURIComponent(value)), encodeURIComponent(encodeURIComponent(encodeURIComponent(value)))],
  json: [JSON.stringify(value).slice(1, -1), JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/")],
  jsonUnicode: [JSON.stringify(value).slice(1, -1).replace(/[^\0-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`),
    JSON.stringify(value).slice(1, -1).replace(/[^\0-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`),
    JSON.stringify(value).slice(1, -1).replace(/[<>&'+]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)],
  html: ["&#39;", "&#x27;", "&#X27;", "&#039;", "&apos;", "'"].flatMap((quote) => [
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", quote),
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", quote),
  ]),
  hex: [Buffer.from(value).toString("hex"), Buffer.from(value).toString("hex").toUpperCase()],
});

test("redact replaces the value in every encoding, wherever it sits in a text", () => {
  for (const value of [PLAIN, AWKWARD, "123456", "fake 😀 astral ✓ value", "%25fake%2525%value%", "&amp;fake&lt;&#39;value", "\\\\fake\\u0041\\nvalue\\", "fake/slash/value", "x".repeat(4096)]) {
    const { secrets } = store();
    secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [SITE], value });
    for (const [name, forms] of Object.entries(encodings(value))) {
      for (const form of forms) {
        assert.equal(secrets.redactText(`before ${form} after`), "before [secret] after", `${name} inside a text`);
        assert.equal(secrets.redactText(form), "[secret]", `${name} alone`);
        // Two copies back to back can read as one stretch where an escape is ambiguous; nothing of either is left.
        assert.match(secrets.redactText(`${form}${form}`), /^(\[secret\]){1,2}$/, `${name} twice`);
      }
    }
  }
});

test("redact replaces base64 and base64url of the value at every alignment, with the characters that mix in its bits", () => {
  for (const value of [PLAIN, AWKWARD, "123456", "1234567", "12345678", "fake 😀 astral ✓ value", "fake?>?>~~~value??>>"]) {
    const { secrets } = store();
    secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [SITE], value });
    const size = Buffer.byteLength(value);
    for (const prefix of ["", "u", "us", "use", "user:"]) for (const suffix of ["", "!", "!!", "!!!", "!!!!"]) for (const encoding of ["base64", "base64url"]) {
      const padded = Buffer.from(`${prefix}${value}${suffix}`).toString(encoding);
      for (const encoded of new Set([padded, padded.replace(/=+$/, "")])) {
        // Only the characters made of the neighbours' bits alone stay; padding goes with the value when it ends the text.
        const kept = encoded.slice(Math.ceil((prefix.length + size) * 8 / 6));
        const expected = `${encoded.slice(0, Math.floor(prefix.length * 8 / 6))}[secret]${suffix ? kept : ""}`;
        assert.equal(secrets.redactText(`before ${encoded} after`), `before ${expected} after`, `${encoding} after ${prefix.length} and before ${suffix.length} bytes`);
        assert.equal(secrets.redactText(encoded), expected);
      }
    }
  }
});

test("made-up values of every shape are swapped exactly and redacted in every encoding", () => {
  // A fixed sequence, so a failure can be replayed.
  let seed = 20240607;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const alphabet = [..."abcXYZ0159%\\&+ \"'<>/=;#ux2-_.~!*()\n\té✓😀\u2028\0?:@$,[]{}|^`"];
  const boundary = "----fakeBoundaryXbX";
  for (let round = 0; round < 400; round++) {
    const value = `fake${Array.from({ length: 2 + Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("")}`;
    const { secrets, placeholder } = seeded({ value });
    for (const [name, forms] of Object.entries(encodings(value))) {
      for (const form of forms) assert.equal(secrets.redactText(`| ${form} |`), "| [secret] |", `${name} of value ${round}`);
    }
    const json = secrets.rewrite(jsonRequest({ a: placeholder, [`k${placeholder}`]: [`x${placeholder}y`] }));
    assert.deepEqual(JSON.parse(json.body.toString()), { a: value, [`k${value}`]: [`x${value}y`] }, `JSON with value ${round}`);
    const form = secrets.rewrite(request({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(`a=${placeholder}&k${placeholder}=x${placeholder}y`) }));
    assert.deepEqual([...new URLSearchParams(form.body.toString())], [["a", value], [`k${value}`, `x${value}y`]], `form with value ${round}`);
    const text = secrets.rewrite(request({ headers: { "Content-Type": "text/plain" }, body: Buffer.from(`a=${placeholder}\r\n`) }));
    assert.equal(text.body.toString(), `a=${value}\r\n`, `text with value ${round}`);
    const parts = (secret) => multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="a"', body: secret }]);
    const multi = secrets.rewrite(request({ headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: parts(placeholder) }));
    if (/[\r\n]/.test(value)) assert.deepEqual(multi, { action: "fail" }, `multipart with value ${round}`);
    else assert.ok(multi.body.equals(parts(value)), `multipart with value ${round}`);
  }
});

test("redact replaces placeholders, every one ever issued by the store, and only those", () => {
  const { secrets, secret, placeholder, clock } = seeded();
  const second = secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: SITE, ref: "e1" }).placeholder;
  const elsewhere = seeded().placeholder;
  assert.equal(secrets.redactText(`a ${placeholder} b ${second}${placeholder} c`), "a [secret placeholder] b [secret placeholder][secret placeholder] c");
  assert.equal(secrets.redactText(placeholder), "[secret placeholder]");
  assert.equal(secrets.redactText(elsewhere), elsewhere);
  assert.equal(secrets.redactText(placeholder.slice(0, 31)), placeholder.slice(0, 31));
  secrets.remove("s1", secret.secretRef);
  clock.at += 3_600_000;
  assert.equal(secrets.redactText(`${placeholder} ${PLAIN}`), `[secret placeholder] ${PLAIN}`);
  secrets.clear();
  assert.equal(secrets.redactText(second), "[secret placeholder]");
});

test("redact covers strings and keys at any depth, leaves its input alone and passes a PNG at image.data through", () => {
  const { secrets, placeholder } = seeded({ value: AWKWARD });
  secrets.add({ sessionId: "s2", label: "Other conversation", kind: "token", origins: [OTHER], value: PLAIN });
  const png = `iVBORw0KGgo${Buffer.from(`pixels ${PLAIN} pixels`).toString("base64")}`;
  const shared = { text: `shared ${PLAIN}` };
  const input = {
    ok: true, count: 3, nothing: null, missing: undefined, when: new Date(0), bytes: new Uint8Array([1, 2, 3]),
    url: `${SITE}/login?next=${encodeURIComponent(AWKWARD)}`,
    elements: [{ ref: "e1", name: `Password ${AWKWARD}`, value: placeholder, options: [[`deep ${JSON.stringify(AWKWARD)}`]] }, shared, shared],
    [`key ${PLAIN}`]: { [placeholder]: Buffer.from(AWKWARD).toString("hex") },
    image: { mimeType: "image/png", data: png, width: 10, alt: `shot of ${PLAIN}` },
    attachment: { data: png },
    other: { image: { data: `not a picture ${PLAIN}` } },
  };
  Object.defineProperty(input, "__proto__", { value: { polluted: PLAIN }, enumerable: true });
  input.self = input;
  const before = JSON.stringify({ ...input, self: null });
  const output = secrets.redact(input);
  assert.equal(JSON.stringify({ ...input, self: null }), before);
  assert.notEqual(output, input);
  assert.equal(output.self, output);
  assert.equal(output.elements[1], output.elements[2]);
  assert.deepEqual({ ...output, self: null, when: null, bytes: null }, {
    ok: true, count: 3, nothing: null, missing: undefined, when: null, bytes: null, self: null,
    url: `${SITE}/login?next=[secret]`,
    elements: [{ ref: "e1", name: "Password [secret]", value: "[secret placeholder]", options: [['deep "[secret]"']] }, { text: "shared [secret]" }, { text: "shared [secret]" }],
    "key [secret]": { "[secret placeholder]": "[secret]" },
    image: { mimeType: "image/png", data: png, width: 10, alt: "shot of [secret]" },
    attachment: { data: secrets.redactText(png) },
    other: { image: { data: "not a picture [secret]" } },
    ["__proto__"]: { polluted: "[secret]" },
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(output, "__proto__").value, { polluted: "[secret]" });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(output.when, input.when);
  assert.equal(output.bytes, input.bytes);
  assert.notEqual(output.attachment.data, png);
  for (const leaf of [5, null, undefined, true, "short"]) assert.equal(secrets.redact(leaf), leaf);
  assert.deepEqual(secrets.redact([PLAIN, [AWKWARD]]), ["[secret]", ["[secret]"]]);
});

test("redact prefers the longest secret and stays fast on a large page", () => {
  const { secrets } = store({ maxPerSession: 50 });
  const add = (value) => secrets.add({ sessionId: "s1", label: "Example", kind: "token", origins: [SITE], value });
  add("fake-token"); add("fake-token-with-a-longer-tail"); add("fake-token-with");
  assert.equal(secrets.redactText("x fake-token-with-a-longer-tail y fake-token-with z fake-token"), "x [secret] y [secret] z [secret]");
  for (let index = 0; index < 20; index++) add(`fake-${index}-${"abcXYZ019!@#$%^&*()-_=+[]{};:'\",.<>/?\\ é".repeat(8)}`);
  const words = "The quick brown fox jumps over 13 lazy dogs & says \"hello\" at https://app.example/a?b=c%20d&e=f — ";
  const page = `${words.repeat(5000)}fake-token-with-a-longer-tail${words.repeat(200)}`;
  assert.ok(page.length > 500_000);
  secrets.redactText(page);
  const started = performance.now();
  const redacted = secrets.redactText(page);
  const elapsed = performance.now() - started;
  assert.equal(redacted, `${words.repeat(5000)}[secret]${words.repeat(200)}`);
  assert.ok(elapsed < 500, `redacting ${page.length} characters took ${elapsed.toFixed(0)} ms`);
  // The matcher is rebuilt when the secrets change.
  add("lazy dogs & says");
  assert.ok(!secrets.redactText(page).includes("lazy dogs"));
});

const paused = (request, extra = {}) => ({ requestId: "interception-1", resourceType: "XHR", request: { url: `${SITE}/login`, method: "POST", headers: { "Content-Type": "application/json" }, ...request }, ...extra });
const neverRead = () => { throw new Error("the body must not be read"); };

test("decidePausedRequest continues untouched without reading the body when nothing can be swapped", async () => {
  const idle = store().secrets;
  assert.deepEqual(await decidePausedRequest(idle, TAB, paused({ hasPostData: true }), { readBody: neverRead }), { method: "Fetch.continueRequest", params: { requestId: "interception-1" } });
  const { secrets, placeholder } = seeded();
  assert.deepEqual(await decidePausedRequest(secrets, "tab-2", paused({ hasPostData: true, postData: JSON.stringify({ password: placeholder }) }), { readBody: neverRead }),
    { method: "Fetch.continueRequest", params: { requestId: "interception-1" } });
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ method: "GET", headers: { Accept: "*/*" } }), { readBody: neverRead }), { method: "Fetch.continueRequest", params: { requestId: "interception-1" } });
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: JSON.stringify({ user: "someone" }) }), { readBody: neverRead }),
    { method: "Fetch.continueRequest", params: { requestId: "interception-1" } });
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ url: `${OTHER}/collect`, hasPostData: true, postData: JSON.stringify({ password: placeholder }) })),
    { method: "Fetch.continueRequest", params: { requestId: "interception-1" } });
});

test("decidePausedRequest sends the rewritten body as base64, from postData, postDataEntries or readBody", async () => {
  const { secrets, placeholder } = seeded({ value: AWKWARD });
  const text = JSON.stringify({ user: "ünï", password: placeholder });
  const expected = { method: "Fetch.continueRequest", params: { requestId: "interception-1", postData: Buffer.from(JSON.stringify({ user: "ünï", password: AWKWARD })).toString("base64") } };
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: text }), { readBody: neverRead }), expected);
  const half = Math.floor(Buffer.byteLength(text) / 2), bytes = Buffer.from(text);
  const entries = [{ bytes: bytes.subarray(0, half).toString("base64") }, { bytes: bytes.subarray(half).toString("base64") }];
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: "ignored when entries carry the bytes", postDataEntries: entries }), { readBody: neverRead }), expected);
  let reads = 0;
  const readBody = async () => { reads++; return { body: bytes, complete: true }; };
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true }), { readBody }), expected);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postDataEntries: [{ bytes: entries[0].bytes }, {}] }), { readBody }), expected);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: `${text}\ufffd` }), { readBody }), expected);
  assert.equal(reads, 3);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true }), { readBody: async () => ({ body: new Uint8Array(bytes), complete: true }) }), expected);
});

test("decidePausedRequest keeps exact bytes around a swap in a multipart body", async () => {
  const { secrets, placeholder } = seeded();
  const boundary = "----fakeBoundary1234567890";
  const parts = (secret) => multipart(boundary, [{ headers: 'Content-Disposition: form-data; name="password"', body: secret },
    { headers: 'Content-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream', body: Buffer.from([0xff, 0xfe, 0x00, 0x80]) }]);
  const decision = await decidePausedRequest(secrets, TAB, paused({ headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, hasPostData: true, postDataEntries: [{ bytes: parts(placeholder).toString("base64") }] }));
  assert.equal(decision.params.postData, parts(PLAIN).toString("base64"));
  assert.equal(decision.params.headers, undefined);
});

test("decidePausedRequest sends swapped headers as a list in the original order", async () => {
  const { secrets, placeholder } = seeded({ kind: "token" });
  const decision = await decidePausedRequest(secrets, TAB, paused({ method: "GET", headers: { accept: "*/*", Authorization: `Bearer ${placeholder}`, "X-Requested-With": "fetch" } }), { readBody: neverRead });
  assert.deepEqual(decision, { method: "Fetch.continueRequest", params: { requestId: "interception-1",
    headers: [{ name: "accept", value: "*/*" }, { name: "Authorization", value: `Bearer ${PLAIN}` }, { name: "X-Requested-With", value: "fetch" }] } });
});

test("decidePausedRequest blocks what cannot be rewritten safely", async () => {
  const blocked = { method: "Fetch.failRequest", params: { requestId: "interception-1", errorReason: "BlockedByClient" } };
  const { secrets, placeholder } = seeded();
  const text = JSON.stringify({ password: placeholder });
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ headers: { "Content-Type": "application/octet-stream" }, hasPostData: true, postData: text })), blocked);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true }), { readBody: async () => ({ body: Buffer.from(text), complete: false }) }), blocked);
  // The text form lost bytes and the exact body cannot be read: a visible placeholder is not swapped into a guess.
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: `${text}\ufffd` })), blocked);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: `${text}\ufffd` }), { readBody: async () => { throw new Error("gone"); } }), blocked);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true, postData: text, postDataEntries: [{}] })), blocked);
});

test("decidePausedRequest continues with the placeholder when the body cannot be read at all", async () => {
  const { secrets } = seeded();
  const untouched = { method: "Fetch.continueRequest", params: { requestId: "interception-1" } };
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true }), { readBody: async () => { throw new Error("gone"); } }), untouched);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true })), untouched);
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true }), { readBody: async () => ({ body: Buffer.from("{}"), complete: false }) }), untouched);
  assert.deepEqual(state(secrets), ["pending"]);
});

test("decidePausedRequest never rejects", async () => {
  const blocked = (requestId) => ({ method: "Fetch.failRequest", params: { requestId, errorReason: "BlockedByClient" } });
  const { secrets } = seeded();
  assert.deepEqual(await decidePausedRequest(secrets, TAB, undefined), blocked(undefined));
  assert.deepEqual(await decidePausedRequest(secrets, TAB, { requestId: "r2" }), blocked("r2"));
  assert.deepEqual(await decidePausedRequest(secrets, TAB, { requestId: "r3", request: { url: 5 } }), blocked("r3"));
  assert.deepEqual(await decidePausedRequest(secrets, TAB, paused({ hasPostData: true }), { readBody: () => { throw new Error("sync"); } }), { method: "Fetch.continueRequest", params: { requestId: "interception-1" } });
  assert.deepEqual(await decidePausedRequest(undefined, TAB, paused({})), blocked("interception-1"));
  assert.deepEqual(await decidePausedRequest({ live: () => { throw new Error("broken"); } }, TAB, paused({})), blocked("interception-1"));
  assert.deepEqual(await decidePausedRequest({ live: () => true, rewrite: () => { throw new Error("broken"); } }, TAB, paused({})), blocked("interception-1"));
});

test("no error, status or summary anywhere holds a value or a placeholder", () => {
  const { secrets, secret, placeholder } = seeded({ value: AWKWARD });
  const seen = [];
  const record = (run) => { try { seen.push(JSON.stringify(run())); } catch (error) { seen.push(`${error.message} ${error.stack} ${JSON.stringify(error)}`); } };
  record(() => secrets.issue({ sessionId: "s1", secretRef: secret.secretRef, tabId: TAB, origin: OTHER, ref: "e1" }));
  record(() => secrets.issue({ sessionId: "s1", secretRef: AWKWARD, tabId: TAB, origin: SITE, ref: "e1" }));
  record(() => secrets.add({ sessionId: "s1", label: "Example", kind: "password", origins: [AWKWARD], value: AWKWARD }));
  record(() => secrets.rewrite(request({ headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(placeholder) })));
  record(() => secrets.rewrite(jsonRequest({ p: placeholder }, { url: `${OTHER}/x` })));
  record(() => secrets.status("s1", TAB));
  record(() => secrets.list("s1"));
  record(() => secrets.describe("s1", secret.secretRef));
  record(() => secrets.availableFor("s1", SITE));
  assert.equal(seen.length, 9);
  for (const text of seen) assert.ok(!text.includes(AWKWARD) && !text.includes(JSON.stringify(AWKWARD).slice(1, -1)) && !text.includes(placeholder));
});
