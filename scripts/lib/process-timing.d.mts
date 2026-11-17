export interface TimingStep {
  step: string;
  seconds: number;
  outcome: "ok" | "fail" | "skipped";
}

export interface ProcessTiming {
  process: "check" | "world" | "evals";
  startedAt: string;
  totalSeconds: number;
  outcome: "ok" | "fail";
  steps: TimingStep[];
}

export function reportProcessTiming(run: ProcessTiming): Promise<void>;
