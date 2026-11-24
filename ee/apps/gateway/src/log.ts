import { createJsonStdoutLogger } from "@openwork-ee/utils/observability"

export const gatewayLog = createJsonStdoutLogger({ serviceName: "gateway" })
