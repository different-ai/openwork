import { expect, test } from "bun:test";
import { buildInstallDownloadHref } from "../app/(den)/_lib/install-download";

test("organization installer downloads preserve a prefixed public API path", () => {
  expect(buildInstallDownloadHref(
    "https://on-prem.example.test/api/den/",
    "win-x64",
    "opaque/token value",
  )).toBe("https://on-prem.example.test/api/den/v1/install/win-x64?token=opaque%2Ftoken%20value");
});

test("organization installer downloads still support a root API origin", () => {
  expect(buildInstallDownloadHref(
    "https://api.openwork.example.test",
    "mac-arm64",
    "opaque-token",
  )).toBe("https://api.openwork.example.test/v1/install/mac-arm64?token=opaque-token");
});
