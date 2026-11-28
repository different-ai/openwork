import { computerActionForToolCall, formatLastSeen, matchComputers, offlineMessage } from "@openwork/computers";
import { ZodError } from "zod";
import { COMPUTER_STATE_LABELS, computerToolCallSchema, isExecutableVmProvider, type Computer, type ListedComputer } from "@openwork/types/den/computers";
import { routedComputerTool } from "./tool-names.js";
import type { SandboxToolName } from "../sandbox-tool-host.js";
import type { ServerConfig } from "../types.js";
import { bindingApprovalId, computerBindings, type ComputerBinding } from "./bindings.js";
import { computersConnecting, computersUnavailable, type createComputersDen } from "./den.js";
import { computerExecutor } from "./executors/index.js";
import { translateComputerInput } from "./input.js";
import { computerBindingChanged, computerCannotTakeWork, computerUnreachable } from "./messages.js";
import { computerPermissionRequests } from "./permissions.js";

function prepare(tool: SandboxToolName, input: unknown, folder: string) {
  try {
    const translated = translateComputerInput(tool, input, folder);
    return computerToolCallSchema.parse({ tool, input: translated });
  } catch (error) {
    if (error instanceof ZodError) throw new Error("That request can't run on the other computer. Check the command, path, or search pattern. Nothing ran.");
    throw error;
  }
}

export function createComputerService(config: ServerConfig, den: Pick<ReturnType<typeof createComputersDen>, "status" | "authorize"> & Partial<Pick<ReturnType<typeof createComputersDen>, "sourceQueue">> & {
  listComputers(): Promise<{ status: "off" | "unavailable" } | { status: "enabled"; computers: ListedComputer[]; self?: Computer | null }>;
}, executor = computerExecutor) {
  const bindings = computerBindings(config);
  const describe = (computer: ListedComputer) => {
    const lastSeen = computer.state === "offline" ? (computer.lastSeenAt ? `, last seen ${formatLastSeen(computer.lastSeenAt, Date.now())}` : ", not seen yet") : "";
    return `${computer.label} (${COMPUTER_STATE_LABELS[computer.state]}${lastSeen})`;
  };
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
      if ("self" in listed && listed.self?.id === computer.id) {
        await bindings.set(directory, rootId, null);
        return "This chat now runs on this computer.";
      }
      if (computer.kind === "member_machine" && !den.sourceQueue?.()) return computersConnecting;
      if (computer.reach.outcome === "refuse") return computer.reach.message;
      if (computer.kind === "member_machine") {
        if (computer.availability !== "online") return offlineMessage(computer.label, computer.lastSeenAt, Date.now());
        const shares = computer.reach.scope;
        if (computer.provider !== "openwork_desktop" || shares?.surface !== "sandbox") return computerCannotTakeWork(computer.label);
        const [folder] = shares.folders;
        if (!folder) return computerCannotTakeWork(computer.label);
        await bindings.set(directory, rootId, { id: computer.id, label: computer.label, folder, kind: computer.kind, provider: computer.provider, shares });
        return `This chat now runs on ${describe(computer)}. Shared folders: ${shares.folders.map(path => `${path} (${shares.writableFolders?.includes(path) ? "can edit" : "read-only"})`).join(", ")}.`;
      }
      if (computer.kind !== "registered_vm" || !isExecutableVmProvider(computer.provider)) return computerCannotTakeWork(computer.label);
      const folder = computer.reach.scope?.surface === "whole_vm" ? computer.reach.scope.folders[0] : undefined;
      if (!folder) return `I can't use ${computer.label} without its owner's approval to access the entire computer.`;
      await bindings.set(directory, rootId, { id: computer.id, label: computer.label, folder, kind: computer.kind, provider: computer.provider });
      return `This chat now runs on ${describe(computer)}. Work starts in ${folder} there.`;
    },
    permissions(binding: ComputerBinding, name: string, input: unknown) {
      const tool = routedComputerTool(name);
      if (!tool) throw new Error(`This chat runs on ${binding.label}. That tool only works on this computer.`);
      const call = prepare(tool, input, binding.folder);
      const requests = computerPermissionRequests(tool, call.input);
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
      const call = prepare(tool, input, binding.folder);
      if (binding.kind === "member_machine") {
        await getApprovedBinding();
        return executor(binding.provider ?? "openwork_desktop").run({ id: binding.id, label: binding.label, call, signal }, { queue: den.sourceQueue?.() });
      }
      if (binding.provider && !isExecutableVmProvider(binding.provider)) throw new Error(computerCannotTakeWork(binding.label));
      const { decision, connection, computer } = await den.authorize(binding.id, computerActionForToolCall(call), signal);
      if (decision.outcome === "refuse") throw new Error(decision.message);
      if (!connection || computer.kind !== "registered_vm" || computer.id !== binding.id) throw new Error(computerUnreachable(binding.label));
      await getApprovedBinding();
      if (binding.provider && connection.provider !== binding.provider) throw new Error(computerBindingChanged);
      if (!isExecutableVmProvider(connection.provider)) throw new Error(computerCannotTakeWork(computer.label));
      return executor(connection.provider).run({ id: binding.id, label: computer.label, connection, scope: decision.scope, call, signal }, {});
    },
  };
}
