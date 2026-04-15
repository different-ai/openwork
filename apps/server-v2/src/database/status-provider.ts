export type DatabaseStatus = {
  configured: false;
  kind: "none";
  phaseOwner: 2;
  status: "pending";
  summary: string;
};

export type DatabaseStatusProvider = {
  getStatus(): DatabaseStatus;
};

export function createPhase1DatabaseStatusProvider(): DatabaseStatusProvider {
  return {
    getStatus() {
      return {
        configured: false,
        kind: "none",
        phaseOwner: 2,
        status: "pending",
        summary: "Server V2 does not attach a durable database until Phase 2.",
      };
    },
  };
}
