import assert from "node:assert/strict";
import { test } from "node:test";
import { readDenApiBase } from "./den-api-base";

test("DEN_API_BASE is used as set, whatever else is configured", () => {
  assert.equal(readDenApiBase({
    DEN_API_BASE: "http://den-api.internal:8788/",
    DEN_API_PUBLIC_URL: "https://api.openwork.example.test",
    DEN_BASE_URL: "https://openwork.example.test",
  }), "http://den-api.internal:8788");
});

test("without DEN_API_BASE the explicit public API address is used", () => {
  assert.equal(readDenApiBase({
    DEN_API_PUBLIC_URL: "https://openwork-api.example.test",
    DEN_BASE_URL: "https://openwork.example.test",
  }), "https://openwork-api.example.test");
});

test("with only DEN_BASE_URL the API is reached at api.<host>", () => {
  assert.equal(readDenApiBase({ DEN_BASE_URL: "https://openwork.example.test" }), "https://api.openwork.example.test");
  assert.equal(readDenApiBase({ DEN_API_BASE: "  ", DEN_BASE_URL: "openwork.example.test" }), "https://api.openwork.example.test");
});

test("nothing configured, or a DEN_BASE_URL that is not an origin, gives no address", () => {
  assert.equal(readDenApiBase({}), null);
  assert.equal(readDenApiBase({ DEN_BASE_URL: "https://openwork.example.test/den" }), null);
});
