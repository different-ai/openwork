export type WelcomeDenAuthStatus =
  | "checking"
  | "signed_in"
  | "unavailable"
  | "signed_out";

export function shouldHoldWelcomeForDenSession({
  authStatus,
  hasStoredAuthToken,
  isSignedIn,
}: {
  authStatus: WelcomeDenAuthStatus;
  hasStoredAuthToken: boolean;
  isSignedIn: boolean;
}) {
  return isSignedIn || (hasStoredAuthToken && authStatus === "checking");
}
