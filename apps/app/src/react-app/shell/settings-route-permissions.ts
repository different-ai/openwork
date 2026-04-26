export function resolveCanManageMcp(input: {
  serverConnected: boolean;
  serverMcpWrite: boolean | null;
  isRemoteWorkspace: boolean;
}): boolean {
  if (input.serverConnected) {
    return input.serverMcpWrite === true;
  }
  return !input.isRemoteWorkspace;
}
