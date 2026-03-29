import { createContext, useContext, type Accessor, type ParentProps } from "solid-js";

import type { ScheduledJob } from "../types";

export type ScheduledJobsContextValue = {
  scheduledJobs: Accessor<ScheduledJob[]>;
  scheduledJobsSource: Accessor<"local" | "remote">;
  schedulerPluginInstalled: Accessor<boolean>;
  scheduledJobsStatus: Accessor<string | null>;
  scheduledJobsBusy: Accessor<boolean>;
  scheduledJobsUpdatedAt: Accessor<number | null>;
  refreshScheduledJobs: (options?: { force?: boolean }) => Promise<void>;
  deleteScheduledJob: (name: string) => Promise<void> | void;
};

const ScheduledJobsContext = createContext<ScheduledJobsContextValue | undefined>(undefined);

export function ScheduledJobsProvider(props: ParentProps<{ value: ScheduledJobsContextValue }>) {
  return (
    <ScheduledJobsContext.Provider value={props.value}>
      {props.children}
    </ScheduledJobsContext.Provider>
  );
}

export function useScheduledJobs() {
  const context = useContext(ScheduledJobsContext);
  if (!context) {
    throw new Error("Scheduled jobs context is missing");
  }
  return context;
}
