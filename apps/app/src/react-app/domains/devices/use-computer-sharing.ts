import { useRef } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ComputerSharingSettings, ComputerSharingState } from "@openwork/types/computer-sharing"
import { isElectronRuntime } from "@/app/lib/runtime-env"
import { readLocalComputerServer } from "@/react-app/infra/local-computer-server"

export function useComputerSharing(scope: readonly unknown[]) {
  const queryClient = useQueryClient()
  const desktop = isElectronRuntime()
  const queryKey = ["openwork-server", "computer-sharing", ...scope]
  const saving = useRef(false)
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const server = await readLocalComputerServer()
      return server ? server.client.getComputerSharing(signal) : null
    },
    enabled: desktop,
    refetchInterval: desktop ? 5_000 : false,
    refetchOnMount: "always",
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: async (next: ComputerSharingSettings) => {
      const server = await readLocalComputerServer()
      if (!server) throw new Error("computer_sharing_server_unavailable")
      return server.client.putComputerSharing(next)
    },
    onMutate: () => queryClient.cancelQueries({ queryKey, exact: true }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
    onSettled: () => { saving.current = false; void queryClient.invalidateQueries({ queryKey, exact: true }) },
  })
  const update = (change: (settings: ComputerSharingSettings) => ComputerSharingSettings | null) => {
    const current = queryClient.getQueryData<ComputerSharingState | null>(queryKey)
    if (!desktop || saving.current || current?.availability.state !== "available" || current.organizationAllows === false) return
    const next = change(current.settings)
    if (!next) return
    saving.current = true
    mutation.mutate(next)
  }
  const settings = mutation.isPending ? mutation.variables : query.data?.settings
  return { query, desktop, settings, update, busy: mutation.isPending, error: mutation.error, resetError: mutation.reset }
}
