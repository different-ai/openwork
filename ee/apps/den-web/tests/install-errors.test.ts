import { describe, expect, test } from "bun:test";
import { getInstallConfigErrorMessage } from "../app/(den)/_lib/install-errors";

describe("getInstallConfigErrorMessage", () => {
  test("does not expose the API error code for expired or invalid links", () => {
    expect(getInstallConfigErrorMessage({ error: "install_link_not_found" }, 404)).toBe(
      "This install link is expired or no longer available. Ask your organization admin for a fresh link.",
    );
  });

  test("keeps useful server messages for other failures", () => {
    expect(getInstallConfigErrorMessage({ message: "Please try again later." }, 503)).toBe("Please try again later.");
  });
});
