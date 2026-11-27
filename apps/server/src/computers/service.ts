import { matchComputers } from "@openwork/computers";
import { COMPUTER_STATE_LABELS, type ListedComputer } from "@openwork/types/den/computers";
import { routedComputerTool } from "./tool-names.js";
import type { ServerConfig } from "../types.js";
import { computerBindings, type ComputerBinding } from "./bindings.js";
import { computersUnavailable, type createComputersDen } from "./den.js";
import { runOnComputer } from "./executor.js";
import { computerActionForTool, translateComputerInput } from "./input.js";

export function createComputerService(config: ServerConfig, den: ReturnType<typeof createComputersDen>) {
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
      if (computer.kind !== "registered_vm" || computer.provider !== "daytona") return `OpenWork can't reach ${computer.provider} computers yet.`;
      const folder = computer.reach.scope?.surface === "whole_vm" ? computer.reach.scope.folders[0] : undefined;
      if (!folder) return `I can't use ${computer.label} without its owner's approval to access the entire computer.`;
      await bindings.set(directory, rootId, { id: computer.id, label: computer.label, folder });
      return `This chat now runs on ${describe(computer)}. Work starts in ${folder} there.`;
    },
    async execute(binding: ComputerBinding, name: string, input: unknown, signal: AbortSignal) {
      const tool = routedComputerTool(name);
      if (!tool) throw new Error(`This chat runs on ${binding.label}. That tool only works on this computer.`);
      const translated = translateComputerInput(tool, input, binding.folder);
      const authorization = await den.authorize(binding.id, computerActionForTool(tool, translated), signal);
      const { decision, connection, computer } = authorization;
      if (decision.outcome === "refuse") throw new Error(decision.message);
      if (!connection || computer.kind !== "registered_vm" || computer.id !== binding.id) throw new Error(`OpenWork can't reach ${binding.label} from this chat.`);
      return runOnComputer({ connection, scope: decision.scope, label: computer.label, tool, input, translated, signal });
    },
  };
}
