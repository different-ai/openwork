import { getErrorMessage } from "./den-flow";

const EXPIRED_INSTALL_LINK_MESSAGE = "This install link is expired or no longer available. Ask your organization admin for a fresh link.";

export function getInstallConfigErrorMessage(payload: unknown, status: number) {
  if (status === 404) {
    return EXPIRED_INSTALL_LINK_MESSAGE;
  }

  return getErrorMessage(payload, `Could not load this install link (${status}).`);
}
