import * as React from "react";

/**
 * Where tooltips and popovers portal to. Set it around UI drawn into a window
 * of its own, so their overlays open there instead of in the app window.
 */
export const PortalContainerContext = React.createContext<HTMLElement | undefined>(undefined);
