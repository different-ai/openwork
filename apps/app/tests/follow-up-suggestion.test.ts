import { expect, test } from "bun:test";

import { followUpPrompt, parseFollowUpSuggestion } from "../src/react-app/domains/session/surface/composer/follow-up-suggestion";

test("shows a request the person can send", () => {
  expect(parseFollowUpSuggestion("Run the tests")).toBe("Run the tests");
  expect(parseFollowUpSuggestion('"Yes, open the PR"')).toBe("Yes, open the PR");
});

test("shows the person's own question", () => {
  expect(parseFollowUpSuggestion("Why did it fail?")).toBe("Why did it fail?");
  expect(parseFollowUpSuggestion("Should I use Postgres instead?")).toBe("Should I use Postgres instead?");
});

test("shows nothing when the model declines or speaks as the assistant", () => {
  expect(parseFollowUpSuggestion("NONE")).toBeNull();
  expect(parseFollowUpSuggestion("Would you like me to run the tests?")).toBeNull();
  expect(parseFollowUpSuggestion("Want me to add a test?")).toBeNull();
  expect(parseFollowUpSuggestion("What would you like to do next?")).toBeNull();
  expect(parseFollowUpSuggestion("Let me know if you need anything else")).toBeNull();
});

test("asks the model to write as the user, not to ask the user something", () => {
  const prompt = followUpPrompt({ messages: [{ role: "user", text: "Fix the login bug" }, { role: "assistant", text: "Fixed. Want me to add a test?" }] });
  expect(prompt).toContain("Write it as the user, never as the assistant");
  expect(prompt).toContain("Never ask the user something");
});
