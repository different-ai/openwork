import assert from "node:assert/strict";
import test from "node:test";
import { getAuthResumeUrl, signsInInPlace } from "./auth-resume";

const origin = "https://den.example.test";
const search = `?id=cob_${"0".repeat(26)}&org=org_${"1".repeat(26)}`;

test("artifact links sign in in place and keep their query on callback", () => {
  for (const pathname of ["/artifact", "/artifact/"]) {
    assert.equal(signsInInPlace(pathname), true);
    assert.equal(getAuthResumeUrl({ pathname, search }, origin), `${origin}/artifact${search}`);
  }
});

test("only the exact artifact route signs in in place", () => {
  for (const pathname of ["/artifacts", "/artifact/nested", "/dashboard"]) {
    assert.equal(signsInInPlace(pathname), false);
    assert.equal(getAuthResumeUrl({ pathname, search }, origin), null);
  }
});

test("existing in-place links still resume on the same path", () => {
  for (const pathname of ["/connect/mcp", "/device", "/claim", "/join-sandbox"]) {
    assert.equal(getAuthResumeUrl({ pathname, search: "?value=example" }, origin), `${origin}${pathname}?value=example`);
  }
});
