import { requestAdmin, sendAdmin } from "../admin-request";
import { parseServicesSnapshot, SERVICES_PATH, type ServicesTransport } from "./service-readiness-data";

/** Stable internal adapter; never imported by organization settings. */
export const adminServicesTransport: ServicesTransport = {
  getSnapshot: (signal) => requestAdmin(SERVICES_PATH, parseServicesSnapshot, signal),
  startCheck: async (signal) => {
    signal.throwIfAborted();
    const response = await sendAdmin(`${SERVICES_PATH}/check`, "POST", undefined, signal);
    signal.throwIfAborted();
    if (!response.ok) return { access: "error", message: "", status: response.status, code: response.code, retryAfterSeconds: response.retryAfterSeconds };
    const snapshot = parseServicesSnapshot(response.payload);
    return snapshot ? { access: "ready", data: snapshot } : { access: "error", message: "" };
  },
};
