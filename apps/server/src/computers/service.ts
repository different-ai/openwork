import { matchComputers } from "@openwork/computers";
import { ZodError } from "zod";
import { COMPUTER_STATE_LABELS, type ListedComputer } from "@openwork/types/den/computers";
import { routedComputerTool } from "./tool-names.js";
import type { SandboxToolName } from "../sandbox-tool-host.js";
import type { ServerConfig } from "../types.js";
import { bindingApprovalId, computerBindings, type ComputerBinding } from "./bindings.js";
import { computersUnavailable, type createComputersDen } from "./den.js";
import { runOnComputer } from "./executor.js";
import { computerActionForTool, translateComputerInput } from "./input.js";
import { computerBindingChanged, computerCannotTakeWork, computerUnreachable } from "./messages.js";
import { computerPermissionRequests } from "./permissions.js";

function prepare(tool: SandboxToolName, input: unknown, folder: string) {
  try {
    const translated = translateComputerInput(tool, input, folder);
    return { translated, action: computerActionForTool(tool, translated) };
  } catch (error) {
    if (error instanceof ZodError) throw new Error("That request can't run on the other computer. Check the command, path, or search pattern. Nothing ran.");
    throw error;
  }
}

export function createComputerService(config: ServerConfig, den: ReturnType<typeof createComputersDen>, run = runOnComputer) {
  const bindings = computerBindings(config);
  const describe = (computer: ListedComputer) => `${computer.label} (${COMPUTER_STATE_LABELS[computer.state]})`;
  const names = (computers: ListedComputer[]) => computers.length ? computers.map(describe).join(", ") : "No other computers are available.";
  return {
    async status() { return { status: await den.status() }; },
    binding: bindings.get,
    async select(directory: string, rootId: string, requested?: string) {
      const listed = await den.listComputers();
      if (listed.status !== "enabled") throw new Error(computersUnavailable);
      const { computers } = listed;
      const query = requested?.trim();
      if (!query) {
        const binding = await bindings.get(directory, rootId);
        return `This chat runs on ${binding?.label ?? "this computer"}. ${names(computers)}`;
      }
      const matches = matchComputers(query, computers);
      if (query.toLowerCase() === "this computer" || (matches.length === 1 && matches[0]?.kind === "member_machine" && matches[0].availability === "online" && matches[0].label.toLowerCase() === "this computer")) {
        await bindings.set(directory, rootId, null);
        return "This chat now runs on this computer.";
      }
      if (matches.length > 1) return `More than one computer matches: ${names(matches)}. Ask which one to use.`;
      const [computer] = matches;
      if (!computer) return `I couldn't find a computer called ${query}. ${names(computers)}`;
      if (computer.reach.outcome === "refuse") return computer.reach.message;
      if (computer.kind !== "registered_vm" || computer.provider !== "daytona") return computerCannotTakeWork(computer.label);
      const folder = computer.reach.scope?.surface === "whole_vm" ? computer.reach.scope.folders[0] : undefined;
      if (!folder) return `I can't use ${computer.label} without its owner's approval to access the entire computer.`;
      await bindings.set(directory, rootId, { id: computer.id, label: computer.label, folder });
      return `This chat now runs on ${describe(computer)}. Work starts in ${folder} there.`;
    },
    permissions(binding: ComputerBinding, name: string, input: unknown) {
      const tool = routedComputerTool(name);
      if (!tool) throw new Error(`This chat runs on ${binding.label}. That tool only works on this computer.`);
      const { translated } = prepare(tool, input, binding.folder);
      const requests = computerPermissionRequests(tool, translated);
      return { bindingId: bindingApprovalId(binding), label: binding.label, requests };
    },
    async execute(directory: string, rootId: string, bindingId: string, name: string, input: unknown, signal: AbortSignal) {
      const getApprovedBinding = async () => {
        const binding = await bindings.get(directory, rootId);
        if (!binding || bindingApprovalId(binding) !== bindingId) throw new Error(computerBindingChanged);
        return binding;
      };
      const binding = await getApprovedBinding();
      const tool = routedComputerTool(name);
      if (!tool) throw new Error(`This chat runs on ${binding.label}. That tool only works on this computer.`);
      const { translated, action } = prepare(tool, input, binding.folder);
      const { decision, connection, computer } = await den.authorize(binding.id, action, signal);
      if (decision.outcome === "refuse") throw new Error(decision.message);
      if (!connection || computer.kind !== "registered_vm" || computer.id !== binding.id) throw new Error(computerUnreachable(binding.label));
      await getApprovedBinding();
      return run({ connection, scope: decision.scope, label: computer.label, tool, input, translated, signal });
    },
  };
}
