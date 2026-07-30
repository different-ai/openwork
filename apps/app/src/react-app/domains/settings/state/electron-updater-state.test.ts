declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  ELECTRON_UPDATER_UNSUPPORTED_REASON,
  shouldScheduleElectronUpdateAutoCheck,
  unsupportedElectronUpdaterEnvState,
} from "./electron-updater-state";

describe("electron updater web unsupported state", () => {
  test("marks the updater environment unsupported in web", () => {
    expect(unsupportedElectronUpdaterEnvState()).toEqual({
      appVersion: null,
      updateEnv: {
        supported: false,
        reason: ELECTRON_UPDATER_UNSUPPORTED_REASON,
      },
    });
  });

  test("does not schedule automatic checks when unsupported", () => {
    expect(shouldScheduleElectronUpdateAutoCheck({
      updateAutoCheck: true,
      updateEnv: unsupportedElectronUpdaterEnvState().updateEnv,
      autoCheckKey: null,
      nextAutoCheckKey: "stable:unknown",
    })).toBe(false);
  });
});
