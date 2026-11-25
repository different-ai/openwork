export function cloudSurfaceAvailable(input: {
  deploymentEnabled: boolean;
  authChecking: boolean;
  signedIn: boolean;
}): boolean {
  if (input.deploymentEnabled) return true;
  return !input.authChecking && !input.signedIn;
}
