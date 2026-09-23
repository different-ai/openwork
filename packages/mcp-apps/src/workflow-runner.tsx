import { workflowRunnerOpenOutputSchema } from "@openwork/types/workflow-runner-app"
import { mountMcpApp } from "./shared/bridge"
import { WorkflowView } from "./workflow-view"
import "./workflow.css"

mountMcpApp({
  name: "Workflows",
  schema: workflowRunnerOpenOutputSchema,
  acceptError: payload => payload.kind === "workflow_error",
  preserveState: true,
  render: props => <WorkflowView {...props} />,
})
