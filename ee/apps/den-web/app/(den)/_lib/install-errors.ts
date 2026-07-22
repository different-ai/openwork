import { getErrorMessage } from "./den-flow";

const EXPIRED_INSTALL_LINK_MESSAGE = "This install link has expired or was replaced. Ask your workspace admin for a fresh one from the Members page.";

export function getInstallConfigErrorMessage(payload: unknown, status: number) {
  if (status === 404) {
    return EXPIRED_INSTALL_LINK_MESSAGE;
  }

  return getErrorMessage(payload, `Could not load this install link (${status}).`);
}
