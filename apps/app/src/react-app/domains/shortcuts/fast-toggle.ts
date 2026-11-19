// Toggle Fast on the focused conversation's model without touching its
// reasoning level. Pure so the not-offered path is tested with the rule:
// a model without Fast never changes, and the person is told why.
import { getModelBehaviorControls } from "@/app/lib/model-behavior";

export type FastToggleDecision =
  | { kind: "not_offered" }
  | { kind: "toggle"; next: string | null; fastOn: boolean };

export function decideFastToggle(
  options: ReadonlyArray<{ value: string | null }>,
  current: string | null,
): FastToggleDecision {
  const controls = getModelBehaviorControls(options, current);
  if (!controls.hasFast || controls.toggleValue === undefined) return { kind: "not_offered" };
  return { kind: "toggle", next: controls.toggleValue ?? null, fastOn: !controls.fast };
}
