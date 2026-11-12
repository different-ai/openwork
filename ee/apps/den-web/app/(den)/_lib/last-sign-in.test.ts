import assert from "node:assert/strict";
import { test } from "node:test";
import { readLastSignInMethod } from "./last-sign-in";

test("reads the remembered password or social method", () => {
  assert.equal(readLastSignInMethod("openwork-last-sign-in=google"), "google");
  assert.equal(readLastSignInMethod("a=1; openwork-last-sign-in=github; b=2"), "github");
  assert.equal(readLastSignInMethod(" openwork-last-sign-in = password "), "password");
});

test("anything else means nothing is remembered", () => {
  assert.equal(readLastSignInMethod(""), null);
  assert.equal(readLastSignInMethod("openwork-last-sign-in="), null, "cleared after an SSO sign-in");
  assert.equal(readLastSignInMethod("openwork-last-sign-in=sso"), null, "SSO is never remembered");
  assert.equal(readLastSignInMethod("x-openwork-last-sign-in=google"), null);
  assert.equal(readLastSignInMethod("openwork-last-sign-in-extra=google"), null);
});
