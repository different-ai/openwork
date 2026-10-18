import { WorkbotScreen, WorkbotAuthorizationProvider, DiscardRetainedRecovery, DOCUMENT_RECOVERY_MS, type WorkbotHost } from "@openwork-ee/workbot-ui"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createHost, fetchMe, signIn, type Me } from "./host"
import "./styles.css"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
const action = "rounded-full bg-[var(--wb-chip)] px-4 py-2 text-[14px] text-[var(--wb-text)] focus-visible:outline focus-visible:outline-2"
const sameIdentity = (left: Me, right: Me) => left.userId === right.userId && left.organizationId === right.organizationId

function Signed({ me, authorization, refreshIdentity }: { me: Me; authorization?: WorkbotHost["documentAuthorization"]; refreshIdentity(): Promise<Me | null> }) {
  const host = useMemo(() => createHost(me, { authorization, refreshIdentity }), [me, authorization, refreshIdentity])
  // Existing query keys need not be globally unique: each retained owner has
  // its own client, so a later account cannot inherit the previous cache.
  const queries = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), [me.organizationId, me.userId])
  const dispose = useRef<ReturnType<typeof setTimeout>>(undefined)
  const previousAuthorization = useRef(authorization)
  useEffect(() => {
    if (previousAuthorization.current !== undefined && authorization === undefined) {
      // Resume ordinary reads, never mutations or document session factories.
      void queries.invalidateQueries({ predicate: query => query.queryKey[0] !== "documents" })
    }
    previousAuthorization.current = authorization
  }, [queries, authorization])
  useEffect(() => {
    clearTimeout(dispose.current)
    return () => { dispose.current = setTimeout(() => queries.clear(), 0) }
  }, [queries])
  return <QueryClientProvider client={queries}><WorkbotAuthorizationProvider value={authorization}><WorkbotScreen host={host} /></WorkbotAuthorizationProvider></QueryClientProvider>
}

function App() {
  const me = useQuery({ queryKey: ["workbot", "me"], queryFn: fetchMe, staleTime: 60_000, refetchOnReconnect: "always" })
  const [owner, setOwner] = useState<Me | null>(null)
  const [until, setUntil] = useState<number | null>(null)
  const changedIdentity = owner !== null && me.data != null && !sameIdentity(owner, me.data)
  const identityUnavailable = me.isError || me.failureCount > 0
  const workspaceDisabled = owner?.enabled === true && me.isSuccess && me.data != null && !changedIdentity && !me.data.enabled
  const verified = me.isSuccess && !identityUnavailable && me.data != null && !changedIdentity && !workspaceDisabled
  const blocked = owner !== null && !verified
  useEffect(() => {
    // A successful response for another person must not replace a draft's owner.
    const next = me.data
    if (!me.isSuccess || identityUnavailable || !next) return
    setOwner(current => current === null ? next : sameIdentity(current, next) && !(current.enabled && !next.enabled) ? next : current)
  }, [me.isSuccess, me.data, identityUnavailable, owner])
  useEffect(() => {
    if (!blocked) { setUntil(null); return }
    setUntil(current => current ?? Date.now() + DOCUMENT_RECOVERY_MS)
  }, [blocked])
  useEffect(() => {
    if (until === null) return
    const expiringOwner = owner
    const timer = setTimeout(() => setOwner(current => current === expiringOwner ? null : current), Math.max(0, until - Date.now()))
    return () => clearTimeout(timer)
  }, [until, owner])
  useEffect(() => {
    if (owner === null && me.isSuccess && me.data === null) signIn()
  }, [owner, me.isSuccess, me.data])
  const refreshIdentity = useCallback(async () => {
    const result = await me.refetch()
    return result.isSuccess ? result.data ?? null : null
  }, [me.refetch])
  if (owner !== null) {
    const authorization = blocked ? workspaceDisabled ? "disabled" : identityUnavailable ? "blocked" : "signin" : undefined
    // Hidden, not conditionally removed: auth revalidation cannot run editor teardown.
    return <>
      <div className="h-full" hidden={blocked} data-workbot-retained-owner><Signed key={JSON.stringify([owner.organizationId, owner.userId])} me={owner} authorization={authorization} refreshIdentity={refreshIdentity} /></div>
      {blocked && <main className="workbot grid h-full place-items-center px-6 text-center" role="status" aria-label="Workspace sign-in recovery" aria-busy={me.isFetching}><div className="flex max-w-sm flex-col items-center gap-3">
        <p className="text-[14px] text-[var(--wb-text)]">{workspaceDisabled ? "Workbot is off for this workspace. An admin can turn it on." : changedIdentity ? "The signed-in account or workspace changed. Retained documents are locked." : identityUnavailable ? "Couldn't verify this workspace. Retained documents are locked." : "Sign in again to restore this workspace."}</p>
        <span className="text-[13px] text-[var(--wb-muted)]">Recovery is held here for at most 15 minutes.</span>
        {!workspaceDisabled && <a className={action} href={`/auth/login?return=${encodeURIComponent(window.location.pathname + window.location.search)}`} target="_blank" rel="noopener noreferrer">Sign in again</a>}
        <button type="button" className={action} disabled={me.isFetching} onClick={() => void me.refetch()}>{workspaceDisabled ? "Check workspace access" : "Check sign-in"}</button>
        {changedIdentity && <DiscardRetainedRecovery onDiscard={() => { setOwner(null); setUntil(null); }} />}
      </div></main>}
    </>
  }
  if (me.isError) return <main className="workbot grid h-full place-items-center px-6 text-center"><div className="max-w-sm"><p className="text-[14px] text-[var(--wb-text)]">Workbot can't reach OpenWork right now.</p><button type="button" className={action} onClick={() => void me.refetch()}>Try again</button></div></main>
  return null
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}
