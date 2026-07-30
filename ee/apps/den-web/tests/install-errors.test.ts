import { describe, expect, test } from "bun:test";
import { getInstallConfigErrorMessage } from "../app/(den)/_lib/install-errors";

describe("getInstallConfigErrorMessage", () => {
  test("does not expose the API error code for expired or invalid links", () => {
    const message = getInstallConfigErrorMessage({ error: "install_link_not_found" }, 404);

    expect(message).not.toContain("install_link_not_found");
    expect(message).not.toContain("_");
    expect(message).toContain("install link");
    expect(message).toMatch(/expired/i);
    expect(message).toMatch(/admin/i);
  });

  test("keeps useful server messages for other failures", () => {
    expect(getInstallConfigErrorMessage({ message: "Please try again later." }, 503)).toBe("Please try again later.");
  });
});
