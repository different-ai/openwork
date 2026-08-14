export const TOTAL_GUIDE_STEPS = 4;

export type GuideStep = 1 | 2 | 3 | 4;

/** Step 3 confirms the app is installed and running before activation is offered. */
export const CONFIRM_RUNNING_STEP = 3;

export function parseGuideStep(value: string | null): GuideStep {
  if (value === "4") return 4;
  if (value === "3") return 3;
  if (value === "2") return 2;
  return 1;
}
