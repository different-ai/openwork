import { createContext, use, useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type UseMutateFunction } from "@tanstack/react-query";
import { toast } from "@/components/ui/sonner";

import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { t } from "@/i18n";
import { clearOpenworkEnvSystemContextCache } from "@/react-app/domains/session/sync/env-context";
import type { EnvironmentVariableItem } from "./environment-variable-table";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_"] as const;

export type ApplyEnvironmentChangesResult = { statusMessage?: string } | void;

export type EnvironmentEditorDraft = {
  mode: "add" | "edit";
  key: string;
  value: string;
};

function validateKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) {
    return t("settings.environment.validation_empty");
  }
  if (!KEY_PATTERN.test(trimmed)) {
    return t("settings.environment.validation_shape");
  }
  if (RESERVED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return t("settings.environment.validation_reserved");
  }
  return null;
}

type UseEnvironmentVariableListOptions = {
  client: OpenworkServerClient | null;
  isRemoteWorkspace: boolean;
  runtimeKey?: string | null;
};

export function environmentUserEnvQueryKey(runtimeKey?: string | null) {
  return ["settings", "environment", "user-env", runtimeKey];
}

export function useEnvironmentVariableList(options: UseEnvironmentVariableListOptions) {
  return useQuery({
    queryKey: environmentUserEnvQueryKey(options.runtimeKey),
    queryFn: async () => {
      if (!options.client || options.isRemoteWorkspace) {
        return { items: [] };
      }

      return options.client.listUserEnv();
    },
    enabled: options.client !== null && !options.isRemoteWorkspace,
    refetchOnWindowFocus: false,
  });
}

export interface ApplyAsyncOptions {
  onSuccess?: () => void;
}

export interface ModifyAsyncOptions {
  onSuccess?: () => void;
}

export interface RemoveAsyncOptions {
  onSuccess?: () => void;
}

interface EnvironmentVariableContextValue {
  canModify: boolean;
  canApplyChanges: boolean;
  isPendingChanges: boolean;
  applyAsync: UseMutateFunction<ApplyEnvironmentChangesResult | undefined, Error, void, unknown>;
  modifyAsync: UseMutateFunction<unknown, Error, EnvironmentEditorDraft, unknown>;
  removeAsync: UseMutateFunction<string, Error, string, unknown>;
  isApplying: boolean;
  isModifying: boolean;
  isRemoving: boolean;
  applyError: Error | null;
  modifyError: Error | null;
  removeError: Error | null;
}

const EnvironmentVariableContext = createContext<EnvironmentVariableContextValue | null>(null);

interface EnvironmentVariableProviderProps {
  children: React.ReactNode;
  client: OpenworkServerClient | null;
  runtimeKey?: string | null;
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
}

export function EnvironmentVariableProvider({ children, client, runtimeKey, onApplyChanges }: EnvironmentVariableProviderProps) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings", "environment", "pending-changes", runtimeKey],
    queryFn: async () => {
      if (!client) return false;
      return (await client.getUserEnvStatus(runtimeKey)).pendingChanges;
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  
  const { mutate: applyAsync, isPending: isApplying, reset: resetApply, error: applyError } = useMutation({
    mutationFn: async () => onApplyChanges?.(),
    onSuccess: (result) => {
      clearOpenworkEnvSystemContextCache();
      queryClient.setQueryData(["settings", "environment", "pending-changes", runtimeKey], false);
      client?.setUserEnvPendingChanges(false, runtimeKey).catch(() => undefined);
      toast.success(result?.statusMessage ?? t("settings.environment.apply_success"));
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const markChangesPending = useCallback(() => {
    clearOpenworkEnvSystemContextCache();
    queryClient.setQueryData(["settings", "environment", "pending-changes", runtimeKey], true);
    resetApply();
    client?.setUserEnvPendingChanges(true, runtimeKey).catch(() => undefined);

    toast.info(t("settings.environment.restart_required"));
  }, [client, resetApply, queryClient, runtimeKey]);

  const { mutate: modifyAsync, isPending: isModifying, reset: resetModify, error: modifyError } = useMutation({
    mutationFn: async (nextEditor: EnvironmentEditorDraft) => {
      if (!client) {
        throw new Error(t("app.unknown_error"));
      }

      const keyError = validateKey(nextEditor.key);

      if (keyError) {
        throw new Error(keyError);
      }

      const key = nextEditor.key.trim();
      const existingItems = queryClient.getQueryData<{ items: EnvironmentVariableItem[] }>(
        environmentUserEnvQueryKey(runtimeKey),
      )?.items;

      if (nextEditor.mode === "add" && existingItems?.some((item) => item.key === key)) {
        throw new Error(t("settings.environment.validation_duplicate"));
      }

      return client.upsertUserEnv([{ key, value: nextEditor.value }]);
    },
    onSuccess: async () => {
      markChangesPending();

      await queryClient.invalidateQueries({
        queryKey: environmentUserEnvQueryKey(runtimeKey),
      });
    },
  }); 

  const { mutate: removeAsync, isPending: isRemoving, reset: resetRemove, error: removeError } = useMutation({
    mutationFn: async (key: string) => {
      if (!client) {
        throw new Error(t("app.unknown_error"));
      }

      await client.deleteUserEnv(key);

      return key;
    },
    onSuccess: async () => {
      markChangesPending();

      await queryClient.invalidateQueries({
        queryKey: environmentUserEnvQueryKey(runtimeKey),
      });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  const value = useMemo<EnvironmentVariableContextValue>(() => ({
    canModify: client !== null,
    canApplyChanges: onApplyChanges !== undefined,
    isPendingChanges: data === true,
    applyAsync,
    modifyAsync,
    removeAsync,
    isApplying,
    isModifying,
    isRemoving,
    applyError,
    modifyError,
    removeError,
  }), [
    client,
    onApplyChanges,
    applyAsync,
    modifyAsync,
    removeAsync,
    data,
    isApplying,
    isModifying,
    isRemoving,
    applyError,
    modifyError,
    removeError,
  ]);

  return (
    <EnvironmentVariableContext.Provider value={value}>
      {children}
    </EnvironmentVariableContext.Provider>
  );
}

function useEnvironmentVariableContext() {
  const context = use(EnvironmentVariableContext);

  if (!context) {
    throw new Error("EnvironmentVariableContext is not available");
  }

  return context;
}

export function useEnvironmentVariableApplyChanges() {
  const { applyAsync, isApplying, applyError } = useEnvironmentVariableContext();

  return {
    applyAsync,
    isApplying,
    error: applyError,
  };
}

export function useEnvironmentVariableModify() {
  const { modifyAsync, isModifying, modifyError } = useEnvironmentVariableContext();


  return {
    modifyAsync,
    isModifying,
    error: modifyError,
  };
}

export function useEnvironmentVariableRemove() {
  const { removeAsync, isRemoving, removeError } = useEnvironmentVariableContext();


  return {
    removeAsync,
    isRemoving,
    error: removeError,
  };
}

export function useIsEnvironmentVariableChangesPending() {
  const { isPendingChanges } = useEnvironmentVariableContext();

  return isPendingChanges;
}

export function useEnvironmentVariableAvailability() {
  const { canModify, canApplyChanges } = useEnvironmentVariableContext();

  return { canModify, canApplyChanges };
}
