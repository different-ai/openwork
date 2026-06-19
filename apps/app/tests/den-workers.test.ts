import { describe, expect, test } from "bun:test";

import {
  canConnectDenWorker,
  countOwnedDenWorkers,
  selectOwnedReadyDenWorker,
} from "@openwork/types/den/workers";

describe("Den worker ownership helpers", () => {
  test("selects only a ready owned worker for private workspace onboarding", () => {
    const shared = { workerId: "shared", status: "healthy", isMine: false, isShared: true };
    const startingOwned = { workerId: "starting", status: "provisioning", isMine: true, isShared: false };
    const readyOwned = { workerId: "mine", status: "healthy", isMine: true, isShared: false };

    expect(selectOwnedReadyDenWorker([shared, startingOwned])).toBeNull();
    expect(selectOwnedReadyDenWorker([shared, startingOwned, readyOwned])).toBe(readyOwned);
  });

  test("treats shared workers as connectable but not owned", () => {
    const shared = { status: "healthy", isMine: false, isShared: true };
    const privateWorker = { status: "healthy", isMine: true, isShared: false };

    expect(canConnectDenWorker(shared)).toBe(true);
    expect(canConnectDenWorker({ ...shared, status: "provisioning" })).toBe(false);
    expect(countOwnedDenWorkers([shared, privateWorker])).toBe(1);
  });
});
