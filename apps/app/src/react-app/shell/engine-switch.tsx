/** @jsxImportSource react */
import { create } from "zustand";
import type { EngineActivity, EngineV2PreviewStatus, OpenworkServerClient } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

export type EngineSwitchClient = Pick<
  OpenworkServerClient,
  "getEngineV2PreviewStatus" | "getEngineActivity" | "switchOpencodeEngine"
>;
export type ChatEngine = "v1" | "v2";

type SwitchPrompt = {
  from: ChatEngine;
  runningTasks: number;
  resolve: (confirmed: boolean) => void;
};

type EngineSwitchState = {
  switchPrompt: SwitchPrompt | null;
  switching: boolean;
};

export const useEngineSwitchStore = create<EngineSwitchState>(() => ({ switchPrompt: null, switching: false }));

export function selectedChatEngine(status: Pick<EngineV2PreviewStatus, "enabled" | "chatRouting">): ChatEngine {
  return status.enabled && status.chatRouting ? "v2" : "v1";
}

function runningOn(activity: EngineActivity | null, engine: ChatEngine): number {
  const count = activity ? (engine === "v1" ? activity.v1 : activity.v2) : null;
  return count ? count.busySessions + count.waitingRequests : 0;
}

/** Check work on the engine being left before changing routing. */
export async function requestEngineSwitch(
  client: EngineSwitchClient,
  engine: ChatEngine,
  from: ChatEngine,
): Promise<EngineV2PreviewStatus | null> {
  const store = useEngineSwitchStore;
  if (store.getState().switching || engine === from) return null;
  store.setState({ switching: true });
  try {
    const activity = await client.getEngineActivity().catch(() => null);
    const runningTasks = runningOn(activity, from);
    if (runningTasks > 0 && from === "v1") {
      toast.error(t("engine_switch.wait_for_v1_tasks"));
      return null;
    }
    if (runningTasks > 0) {
      const confirmed = await new Promise<boolean>((resolve) => {
        store.setState({ switchPrompt: { from, runningTasks, resolve } });
      });
      store.setState({ switchPrompt: null });
      if (!confirmed) return null;
    }
    const next = await client.switchOpencodeEngine(engine);
    window.dispatchEvent(new CustomEvent("openwork-engine-changed"));
    return next;
  } catch (cause) {
    toast.error(cause instanceof Error && cause.message ? cause.message : t("engine_switch.switch_failed"));
    return null;
  } finally {
    store.setState({ switching: false });
  }
}

export function resolveEngineSwitchPrompt(confirmed: boolean) {
  useEngineSwitchStore.getState().switchPrompt?.resolve(confirmed);
}

export function EngineSwitchOverlay() {
  const prompt = useEngineSwitchStore((state) => state.switchPrompt);
  if (!isDesktopRuntime() || !prompt) return null;
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) resolveEngineSwitchPrompt(false); }}>
      <AlertDialogContent data-testid="engine-switch-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("engine_switch.switch_running_title", { count: prompt.runningTasks, engine: prompt.from })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("engine_switch.switch_from_v2")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("engine_switch.keep_engine", { engine: prompt.from })}</AlertDialogCancel>
          <Button variant="destructive" onClick={() => resolveEngineSwitchPrompt(true)}>
            {t("engine_switch.stop_and_switch")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
