import { mountMcpApp } from "./shared/bridge"
import { LegacyConfirmationView, legacyConfirmationSchema } from "./legacy-confirmation-view"

mountMcpApp({
  name: "OpenWork Result",
  schema: legacyConfirmationSchema,
  render: props => <LegacyConfirmationView payload={props.payload} />,
})
