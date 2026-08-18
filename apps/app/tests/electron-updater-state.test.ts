import { afterEach, describe, expect, jest, test } from "bun:test";

import {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  ELECTRON_UPDATER_UNSUPPORTED_REASON,
  scheduleElectronUpdateAutoChecks,
  shouldScheduleElectronUpdateAutoCheck,
  shouldAutomaticallyDownloadUpdate,
  unsupportedElectronUpdaterEnvState,
} from "../src/react-app/domains/settings/state/electron-updater-state";

afterEach(() => {
  jest.useRealTimers();
});

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

  test("checks on startup and every 24 hours while enabled", () => {
    jest.useFakeTimers();
    const runCheck = jest.fn();
    const stop = scheduleElectronUpdateAutoChecks({
      enabled: true,
      supported: true,
      runInitialCheck: true,
      runCheck,
    });

    expect(runCheck).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    expect(runCheck).toHaveBeenCalledTimes(2);

    stop();
    jest.advanceTimersByTime(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  test("does not schedule checks when automatic checks are disabled", () => {
    jest.useFakeTimers();
    const runCheck = jest.fn();
    scheduleElectronUpdateAutoChecks({
      enabled: false,
      supported: true,
      runInitialCheck: true,
      runCheck,
    });

    jest.advanceTimersByTime(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS * 2);
    expect(runCheck).not.toHaveBeenCalled();
  });

  test("does not repeat the startup check when only the interval is rescheduled", () => {
    jest.useFakeTimers();
    const runCheck = jest.fn();
    const stop = scheduleElectronUpdateAutoChecks({
      enabled: true,
      supported: true,
      runInitialCheck: false,
      runCheck,
    });

    expect(runCheck).not.toHaveBeenCalled();
    jest.advanceTimersByTime(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    expect(runCheck).toHaveBeenCalledTimes(1);
    stop();
  });

  test("automatic download remains an explicit preference", () => {
    expect(shouldAutomaticallyDownloadUpdate(true, true)).toBe(true);
    expect(shouldAutomaticallyDownloadUpdate(true, false)).toBe(false);
    expect(shouldAutomaticallyDownloadUpdate(false, true)).toBe(false);
  });
});
