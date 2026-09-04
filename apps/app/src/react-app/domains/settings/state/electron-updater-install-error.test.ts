declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import { resolveElectronUpdaterInstallError } from "./electron-updater-install-error";

describe("electron updater install errors", () => {
  test("maps a native AppImage permission reason to the visible install error state", () => {
    const reason = "Copy or download the AppImage to ~/.local/bin, then run it from there.";

    expect(resolveElectronUpdaterInstallError(reason)).toEqual({
      state: "error",
      message: reason,
      failedAction: "install",
    });
  });
});
