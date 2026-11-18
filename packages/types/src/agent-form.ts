import { z } from "zod";

const option = z.object({
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  tone: z.enum(["default", "warning", "danger", "success"]).optional(),
});

const field = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), question: z.string(), options: z.array(option).min(1), multiple: z.boolean().optional(), display: z.enum(["list", "cards", "tiles"]).optional() }),
  z.object({ kind: z.literal("scale"), question: z.string(), min: z.number().int(), max: z.number().int(), minLabel: z.string(), maxLabel: z.string() }),
  z.object({ kind: z.literal("date"), question: z.string() }),
  z.object({ kind: z.literal("text"), question: z.string(), placeholder: z.string().optional() }),
]);

const agentForm = z.object({ title: z.string(), fields: z.array(field).min(1) });

export type AgentForm = z.infer<typeof agentForm>;
export type AgentFormField = AgentForm["fields"][number];

export function readAgentForm(metadata: unknown, fieldCount: number): AgentForm | undefined {
  const parsed = agentForm.safeParse(typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "form") : undefined);
  return parsed.success && parsed.data.fields.length === fieldCount ? parsed.data : undefined;
}
