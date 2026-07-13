export type ConnectSnapshot = {
  readonly connectEnabled: boolean;
  readonly cloudMcpPresent: boolean;
  readonly googleWorkspace: {
    readonly legacyConfigured: boolean;
  };
};
