import { check, checkManagedTool } from "./managed-policy-client.js";
export default async function managedPolicy() {
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args: unknown }) => checkManagedTool(input.tool, output.args),
    "chat.params": async (input: { model: { providerID: string; id: string } }) => check("model", input.model),
  };
}
