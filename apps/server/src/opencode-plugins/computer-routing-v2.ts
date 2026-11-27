import { z } from "zod";
import { computersSandboxConflict, localComputerTools, routedComputerTool } from "../computers/tool-names.js";
import type { SandboxToolCall } from "../sandbox-tool-host.js";
import type { HostNativeTool, SandboxEngineResult, SandboxPluginContext, SandboxToolMode } from "./openwork-sandbox-v2.js";

const controlInput = z.strictObject({ computer: z.string().max(256).optional() });
export const computerStatusSchema = z.enum(["off", "enabled", "unavailable"]);
type ComputerStatus = z.infer<typeof computerStatusSchema>;
export const computerBindingSchema = z.object({ id: z.string(), label: z.string(), folder: z.string() });
type Location = { sessionId: string; directory?: string };
export type ComputerRouting = {
  status(): Promise<ComputerStatus>;
  binding(location: Location): Promise<z.infer<typeof computerBindingSchema> | null>;
  select(location: Location, input: z.infer<typeof controlInput>, signal: AbortSignal): Promise<string>;
  execute(location: Location, name: string, input: unknown, signal: AbortSignal): Promise<SandboxEngineResult | null>;
};

export function computerRouting(context: SandboxPluginContext, dependencies: ComputerRouting) {
  const root = async (sessionID: string): Promise<Location> => {
    const seen = new Set<string>();
    while (!seen.has(sessionID) && seen.size < 32) {
      seen.add(sessionID);
      if (!context.session.get) return { sessionId: sessionID };
      const session = await context.session.get({ sessionID });
      if (!session) break;
      if (!session.parentID) return { sessionId: sessionID, directory: session.location?.directory };
      sessionID = session.parentID;
    }
    throw new Error("OpenWork couldn't check where this chat runs. Nothing ran on this computer.");
  };
  const control = (mode: SandboxToolMode): HostNativeTool => ({
    name: "runs_on",
    description: "Use this when the person names one of their computers, such as ‘on my build box’. After choosing it, normal file and shell tools work there. Without a name, list their computers and where this chat runs now. Choose ‘this computer’ to switch back.",
    input: z.toJSONSchema(controlInput), options: { codemode: false },
    async execute(value: unknown, call: SandboxToolCall) {
      const text = mode !== "off" ? computersSandboxConflict : await dependencies.select(await root(call.sessionID), controlInput.parse(value), call.signal);
      return { content: [{ type: "text", text }] };
    },
  });
  const routes = (id: string) => routedComputerTool(id) !== undefined;
  return {
    control, routes,
    status: () => dependencies.status().catch((): ComputerStatus => "unavailable"),
    async execute(id: string, value: unknown, call: SandboxToolCall) {
      if (!routes(id) && !localComputerTools.has(id)) return null;
      return dependencies.execute(await root(call.sessionID), id, value, call.signal);
    },
    async instruction(sessionID: string) {
      const binding = await dependencies.binding(await root(sessionID));
      return binding ? `This chat runs on ${binding.label}. Your file and shell tools work there, in ${binding.folder}. Use absolute paths on that computer; this machine's files are not there.` : null;
    },
  };
}
