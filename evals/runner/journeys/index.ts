export * from "./den.ts";
export * from "./desktop.ts";
export * from "./update.ts";

import { acceptInvite, apiSignIn, createOrg, inviteMember, signInWeb, signUpWeb } from "./den.ts";
import { connectDen, firstBoot, openSettings, runPrompt } from "./desktop.ts";

export const journeys = {
  den: {
    signInWeb,
    signUpWeb,
    apiSignIn,
    createOrg,
    inviteMember,
    acceptInvite,
  },
  desktop: {
    firstBoot,
    connectDen,
    runPrompt,
    openSettings,
  },
};
