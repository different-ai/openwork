import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { amzDate, awsUriEncode, signAwsRequest } from "../src/credentials/aws-sigv4.js"

// Vectors from the AWS Signature Version 4 test suite (aws-sig-v4-test-suite):
// `get-vanilla` and `post-vanilla-query`, credentials AKIDEXAMPLE /
// wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, region us-east-1, service "service",
// date 20150830T123600Z.
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }
const now = new Date("2015-08-30T12:36:00Z")

test("sigv4: get-vanilla test-suite vector", () => {
  const headers = new Headers()
  const result = signAwsRequest({ method: "GET", url: new URL("https://example.amazonaws.com/"), headers, body: null, credentials, region: "us-east-1", service: "service", now })
  assert.equal(headers.get("x-amz-date"), "20150830T123600Z")
  assert.equal(
    result.canonicalRequest,
    "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
  assert.equal(
    headers.get("authorization"),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  )
})

test("sigv4: post-vanilla-query test-suite vector", () => {
  const headers = new Headers()
  signAwsRequest({ method: "POST", url: new URL("https://example.amazonaws.com/?Param1=value1"), headers, body: "", credentials, region: "us-east-1", service: "service", now })
  assert.equal(
    headers.get("authorization"),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
  )
})

test("sigv4: bedrock request signs content-type + session token, double-encodes the path and hashes the body", () => {
  const headers = new Headers({ "content-type": "application/json", authorization: "Bearer leaked" })
  const body = JSON.stringify({ messages: [] })
  const url = new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse")
  const result = signAwsRequest({
    method: "POST",
    url,
    headers,
    body,
    credentials: { ...credentials, sessionToken: "SESSION" },
    region: "us-east-1",
    service: "bedrock",
    now: new Date("2026-09-03T12:00:00Z"),
  })
  assert.equal(headers.get("x-amz-security-token"), "SESSION")
  const lines = result.canonicalRequest.split("\n")
  assert.equal(lines[0], "POST")
  assert.equal(lines[1], "/model/anthropic.claude-3-5-sonnet-20241022-v2%253A0/converse")
  assert.ok(result.canonicalRequest.includes("content-type:application/json\n"))
  assert.ok(result.canonicalRequest.includes("x-amz-security-token:SESSION\n"))
  assert.ok(result.canonicalRequest.endsWith("content-type;host;x-amz-date;x-amz-security-token\n" + hashHex(body)))
  assert.match(headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260903\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/)
  // The stale bearer must not survive signing.
  assert.ok(!(headers.get("authorization") ?? "").includes("Bearer"))
})

test("sigv4: helpers", () => {
  assert.equal(amzDate(new Date("2015-08-30T12:36:00.123Z")), "20150830T123600Z")
  assert.equal(awsUriEncode("a b/~-_.:é"), "a%20b%2F~-_.%3A%C3%A9")
})

function hashHex(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
