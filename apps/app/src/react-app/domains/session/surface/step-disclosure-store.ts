import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type StepGroupsByWorkspace = Record<string, Record<string, Record<string, boolean>>>;

type SessionStepDisclosureStore = {
  stepGroupsByWorkspace: StepGroupsByWorkspace;
  setStepGroupOpen: (workspaceId: string, sessionId: string, stepGroupId: string, open: boolean) => void;
};

export function selectStepGroupOpen(
  stepGroupsByWorkspace: StepGroupsByWorkspace,
  workspaceId: string,
  sessionId: string,
  stepGroupId: string,
): boolean {
  return stepGroupsByWorkspace[workspaceId]?.[sessionId]?.[stepGroupId] ?? true;
}

export const useSessionStepDisclosureStore = create<SessionStepDisclosureStore>()(
  persist(
    (set) => ({
      stepGroupsByWorkspace: {},
      setStepGroupOpen: (workspaceId, sessionId, stepGroupId, open) => {
        const workspace = workspaceId.trim();
        const session = sessionId.trim();
        const group = stepGroupId.trim();
        if (!workspace || !session || !group) return;

        set((state) => {
          const workspaceSessions = state.stepGroupsByWorkspace[workspace] ?? {};
          const sessionGroups = workspaceSessions[session] ?? {};
          if (sessionGroups[group] === open) return state;

          return {
            stepGroupsByWorkspace: {
              ...state.stepGroupsByWorkspace,
              [workspace]: {
                ...workspaceSessions,
                [session]: {
                  ...sessionGroups,
                  [group]: open,
                },
              },
            },
          };
        });
      },
    }),
    {
      name: "openwork:session-step-disclosure:v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
