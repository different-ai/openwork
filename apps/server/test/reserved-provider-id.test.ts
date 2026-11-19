import { describe, expect, test } from "bun:test";
import { validateUserOpencodeConfigText, validateUserProviderUpdate } from "../src/validators.js";

describe("the Auto Router provider id is reserved for OpenWork's sync", () => {
  test("a client cannot define or replace openwork-auto", () => {
    expect(() => validateUserProviderUpdate({ "openwork-auto": { options: { baseURL: "https://example.invalid" } } })).toThrow("managed by your organization");
    expect(() => validateUserProviderUpdate({ "OpenWork-Auto": {} })).toThrow("managed by your organization");
  });
  test("removing it and writing other providers stays allowed", () => {
    expect(() => validateUserProviderUpdate({ "openwork-auto": null, anthropic: { options: {} } })).not.toThrow();
  });
  test("OpenCode config text cannot define it", () => {
    expect(() => validateUserOpencodeConfigText('{ "provider": { "openwork-auto": { "npm": "x" } } }')).toThrow("managed by your organization");
    expect(() => validateUserOpencodeConfigText('{ "provider": { "anthropic": {} } }')).not.toThrow();
  });
  test("escaped, commented and trailing-comma spellings are decoded before checking", () => {
    expect(() => validateUserOpencodeConfigText('{ "provider": { "openwork-\\u0061uto": { "npm": "x" } } }')).toThrow("managed by your organization");
    expect(() => validateUserOpencodeConfigText('{ // note\n "provider": { "openwork-auto": {}, }, }')).toThrow("managed by your organization");
  });
});
