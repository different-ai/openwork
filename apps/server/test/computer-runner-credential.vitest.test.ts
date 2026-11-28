import { expect, test } from "vitest";
import { runnerCredentialSchema } from "../src/computers/runner-credential.js";

const token = "fixture-runner";
test.each([
  ["https://den.example.test", "https://den.example.test"],
  ["https://den.example.test/", "https://den.example.test"],
  ["https://den.example.test/api/den", "https://den.example.test/api/den"],
  ["https://den.example.test/api/den///", "https://den.example.test/api/den"],
  ["http://127.0.0.1:3000/api/den/", "http://127.0.0.1:3000/api/den"],
  ["http://localhost/api/den", "http://localhost/api/den"],
  ["http://[::1]/api/den", "http://[::1]/api/den"],
])("normalizes %s to %s", (baseUrl, expected) => {
  expect(runnerCredentialSchema.parse({ baseUrl, token })).toEqual({ baseUrl: expected, token });
});

test.each([
  "https://user@den.example.test/api/den", "https://:password@den.example.test/api/den",
  "https://den.example.test/api/den?query=1", "https://den.example.test/api/den?",
  "https://den.example.test/api/den#bookmark", "https://den.example.test/api/den#",
  "http://den.example.test/api/den", "ftp://den.example.test/api/den", "/api/den",
])("rejects the runner API base %s", baseUrl => {
  expect(runnerCredentialSchema.safeParse({ baseUrl, token }).success).toBe(false);
});
