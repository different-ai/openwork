import { WORKBOT_MAX_STEPS_CHOICES } from "@openwork/types/den/workbot-settings";

/*
 * The step limit select, shared by Manage › Workbot and the Workbot tab of
 * Members › Teams: its options, their labels and its help text.
 */

export const STEP_LIMIT_HELP = "How many steps Workbot can take on one request before it stops and asks for a smaller piece.";

/** A step limit as the select's value and its label: null is the deployment's default, 0 is no limit. */
export function stepLimitValue(maxSteps: number | null): string {
  return maxSteps === null ? "default" : String(maxSteps);
}

export function stepLimitLabel(maxSteps: number | null): string {
  if (maxSteps === null) return "Default";
  if (maxSteps === 0) return "No limit";
  return `${maxSteps.toLocaleString("en-US")} ${maxSteps === 1 ? "step" : "steps"}`;
}

/** The limits offered, plus the saved one when it isn't among them (set through the API), so the select never hides it. */
export function stepLimitChoices(saved: number | null): (number | null)[] {
  const numbers: number[] = [...WORKBOT_MAX_STEPS_CHOICES];
  if (saved !== null && saved !== 0 && !numbers.includes(saved)) numbers.push(saved);
  return [null, ...numbers.sort((left, right) => left - right), 0];
}
