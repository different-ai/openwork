import { mountMcpApp } from "./shared/bridge"
import { ConnectionView, connectionResultSchema } from "./connection-view"

mountMcpApp({
  name: "OpenWork Connection",
  schema: connectionResultSchema,
  acceptError: payload => payload.state !== "connected" && payload.action !== null,
  render: props => <ConnectionView {...props} />,
})
