export const TOTAL_GUIDE_STEPS = 3;

export type GuideStep = 1 | 2 | 3;

export const LINK_STEP = 3;

export function parseGuideStep(value: string | null): GuideStep {
  if (value === "3") return 3;
  if (value === "2") return 2;
  return 1;
}
