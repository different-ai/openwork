import { createJsonStdoutLogger } from "@openwork-ee/utils/observability"

/** One JSON line per event, like den-api, so Render keeps each event and its level together. */
export const gatewayLog = createJsonStdoutLogger({ serviceName: "gateway" })
