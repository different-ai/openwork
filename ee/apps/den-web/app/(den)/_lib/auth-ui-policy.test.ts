import assert from "node:assert/strict";
import { test } from "node:test";
import { isSignInOnly, isWorkbotSignIn } from "../../mcp/workbot-sign-in";
import { emailFirstStepWhenSignUpClosed } from "./auth-ui-policy";

test("the phone app's sign-in is recognized by what Workbot adds to it, and nothing else is", () => {
  const phone = "response_type=code&client_id=openwork-workbot&openwork_sign_in_only=true&state=s";
  assert.equal(isSignInOnly(phone), true);
  assert.equal(isWorkbotSignIn(phone), true);

  assert.equal(isSignInOnly("response_type=code&client_id=openwork-workbot&state=s"), false, "the browser's Workbot sign-in can still create an account");
  assert.equal(isSignInOnly("openwork_sign_in_only=false"), false);
  assert.equal(isSignInOnly("openwork_sign_in_only=1"), false);
  assert.equal(isSignInOnly(""), false);
});

test("where sign-up is closed, an email with no account is asked for a password like any other", () => {
  assert.equal(emailFirstStepWhenSignUpClosed("new_account", true), "password");
  assert.equal(emailFirstStepWhenSignUpClosed("new_account", false), "new_account");
  for (const step of ["email", "sso", "google", "github", "password"]) {
    assert.equal(emailFirstStepWhenSignUpClosed(step, true), step, "an existing account keeps its own way in");
  }
});
