import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { afterAll, beforeAll, expect, it } from "vitest";

// The fixture wraps whatever it finds when it loads. These stand-ins sit under it, so a hole in
// the fixture shows up here as a recorded call and never as a request leaving the machine.
const reached: string[] = [];
const original = {
  fetch: globalThis.fetch, lookup: dns.lookup, promiseLookup: dns.promises.lookup,
  httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get,
};
const STS = "https://sts.us-east-1.amazonaws.com/";
const signed = (role: string) => ({
  method: "POST", body: "Action=GetCallerIdentity&Version=2011-06-15",
  headers: {
    authorization: "AWS4-HMAC-SHA256 Credential=FIXTURE/20260101/us-east-1/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof, Signature=00",
    "x-amz-date": "20260101T000000Z", "x-amz-security-token": role, "x-openwork-proof": "enroll:run:challenge",
  },
});

beforeAll(async () => {
  const record = (layer: string) => (...input: unknown[]) => { reached.push(`${layer} ${String(input[0])}`); throw new Error(`stand-in ${layer} reached`); };
  globalThis.fetch = async (input) => { reached.push(`fetch ${String(input)}`); return new Response("passed through"); };
  Reflect.set(dns, "lookup", record("dns"));
  Reflect.set(dns.promises, "lookup", record("dns.promises"));
  Reflect.set(http, "request", record("http.request"));
  Reflect.set(http, "get", record("http.get"));
  Reflect.set(https, "request", record("https.request"));
  Reflect.set(https, "get", record("https.get"));
  await import("./managed-deployment-aws-identity-preload.mjs");
});

afterAll(() => {
  globalThis.fetch = original.fetch;
  Reflect.set(dns, "lookup", original.lookup);
  Reflect.set(dns.promises, "lookup", original.promiseLookup);
  Reflect.set(http, "request", original.httpRequest);
  Reflect.set(http, "get", original.httpGet);
  Reflect.set(https, "request", original.httpsRequest);
  Reflect.set(https, "get", original.httpsGet);
  Reflect.deleteProperty(globalThis, Symbol.for("openwork.fixture.managedDeploymentAwsIdentity"));
});

it("answers the signed STS identity replay for the fixture account as the role the caller names", async () => {
  const response = await fetch(STS, signed("fixture-role/openwork-0123abcd-runner"));
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("<Account>123456789012</Account>");
  expect(text).toContain("<Arn>arn:aws:sts::123456789012:assumed-role/openwork-0123abcd-runner/fixture-session</Arn>");
  expect(reached).toEqual([]);
});

it("denies an identity it was not given in the fixture's form, without asking anyone else", async () => {
  for (const init of [
    signed("a-real-looking-session-token"),
    { ...signed("fixture-role/openwork-0123abcd-runner"), method: "GET", body: undefined },
    { ...signed("fixture-role/openwork-0123abcd-runner"), body: "Action=AssumeRole&Version=2011-06-15" },
    { method: "POST", body: "Action=GetCallerIdentity&Version=2011-06-15", headers: { "x-amz-security-token": "fixture-role/openwork-0123abcd-runner" } },
  ]) {
    expect((await fetch(STS, init)).status).toBe(403);
  }
  expect(reached).toEqual([]);
});

it("refuses every other request to an amazonaws.com host before it can leave", async () => {
  for (const url of [
    "https://installer-fixture.s3.us-east-1.amazonaws.com/releases/aws/1.4.0/cloudformation.json?versionId=fixture",
    "https://sts.amazonaws.com/", "https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity", "https://sts.us-east-1.amazonaws.com/other",
    "http://sts.us-east-1.amazonaws.com/", "https://sts.us-east-1.amazonaws.com:8443/", "https://AMAZONAWS.COM/", "https://ec2.us-east-1.amazonaws.com./",
  ]) {
    await expect(fetch(url, { method: "POST", body: "Action=GetCallerIdentity&Version=2011-06-15" })).rejects.toThrow(/AWS identity fixture refused/);
  }
  expect(() => https.request("https://secretsmanager.us-east-1.amazonaws.com/")).toThrow(/AWS identity fixture refused/);
  expect(() => https.get({ host: "s3.us-east-1.amazonaws.com", path: "/" })).toThrow(/AWS identity fixture refused/);
  expect(() => http.request(new URL("http://s3.amazonaws.com/"))).toThrow(/AWS identity fixture refused/);
  const failure = await new Promise<Error | null>((resolve) => { dns.lookup("sts.us-east-1.amazonaws.com", (error) => resolve(error)); });
  expect(failure?.message).toMatch(/AWS identity fixture refused/);
  await expect(dns.promises.lookup("logs.us-east-1.amazonaws.com")).rejects.toThrow(/AWS identity fixture refused/);
  expect(reached).toEqual([]);
});

it("leaves every other host alone", async () => {
  expect(await (await fetch("http://127.0.0.1:8790/health")).text()).toBe("passed through");
  expect(() => http.request("http://127.0.0.1:8790/health")).toThrow("stand-in http.request reached");
  expect(() => dns.lookup("not-amazonaws.com.example.com", () => undefined)).toThrow("stand-in dns reached");
  expect(reached).toEqual(["fetch http://127.0.0.1:8790/health", "http.request http://127.0.0.1:8790/health", "dns not-amazonaws.com.example.com"]);
});
