import { WorkbotScreen, WorkbotAuthorizationProvider, DiscardRetainedRecovery, DOCUMENT_RECOVERY_MS, type WorkbotHost } from "@openwork-ee/workbot-ui"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createHost, fetchMe, signIn, type Me } from "./host"
import "./styles.css"
import { WorkspaceAccess } from "./workspace-access"

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
  // While dictation is on its state is re-read every minute, so turning it off stops capture. Every pending read below
  // locks the page, so this one runs on its own: the same person and workspace only update what is cached, and any
  // other answer goes through that locked read.
  const dictation = me.data?.nativeDictation === true
  const refetchMe = me.refetch
  useEffect(() => {
    if (!dictation) return
    const timer = setInterval(() => {
      if (document.hidden) return
      void fetchMe().then(next => {
        const current = queryClient.getQueryData<Me | null>(["workbot", "me"])
        if (next && current && sameIdentity(current, next)) queryClient.setQueryData(["workbot", "me"], next)
        else void refetchMe()
      }, () => { /* A failed read leaves the verified state as it was; the next one tries again. */ })
    }, 60_000)
    return () => clearInterval(timer)
  }, [dictation, refetchMe])
  const [owner, setOwner] = useState<Me | null>(null)
  const [until, setUntil] = useState<number | null>(null)
  const [identityWaiters, setIdentityWaiters] = useState<Array<(value: Me | null) => void>>([])
  const changedIdentity = owner !== null && me.data != null && !sameIdentity(owner, me.data)
  const identityUnavailable = me.isError || me.failureCount > 0
  const workspaceDisabled = owner?.enabled === true && me.isSuccess && me.data != null && !changedIdentity && !me.data.enabled
  // Cached success is not fresh authorization while a different browser session may be resolving.
  const verified = me.isSuccess && !me.isFetching && !identityUnavailable && me.data != null && !changedIdentity && !workspaceDisabled
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
    await me.refetch()
    // Fresh file checks must resume after React has committed the settled authorization,
    // not while the retained owner's policy still reflects this request's pending mask.
    return new Promise<Me | null>(resolve => setIdentityWaiters(current => [...current, resolve]))
  }, [me.refetch])
  useEffect(() => {
    if (me.isFetching || identityWaiters.length === 0) return
    for (const resolve of identityWaiters) resolve(verified ? me.data ?? null : null)
    setIdentityWaiters(current => current.filter(resolve => !identityWaiters.includes(resolve)))
  }, [me.isFetching, me.data, verified, identityWaiters])
  if (owner !== null) {
    const authorization = blocked ? workspaceDisabled ? "disabled" : identityUnavailable || me.isFetching ? "blocked" : "signin" : undefined
    if (!blocked && !owner.enabled) return <WorkspaceAccess me={owner} />
    // Hidden, not conditionally removed: auth revalidation cannot run editor teardown.
    return <>
      <div className="h-full" hidden={blocked} data-workbot-retained-owner><Signed key={JSON.stringify([owner.organizationId, owner.userId])} me={owner} authorization={authorization} refreshIdentity={refreshIdentity} /></div>
      {blocked && <main className="workbot grid h-full place-items-center px-6 text-center" role="status" aria-label="Workspace sign-in recovery" aria-busy={me.isFetching}><div className="flex max-w-sm flex-col items-center gap-3">
        <p className="text-[14px] text-[var(--wb-text)]">{me.isFetching ? "Checking sign-in. Retained documents are locked." : workspaceDisabled ? "Workbot is off for this workspace. An admin can turn it on." : changedIdentity ? "The signed-in account or workspace changed. Retained documents are locked." : identityUnavailable ? "Couldn't verify this workspace. Retained documents are locked." : "Sign in again to restore this workspace."}</p>
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

/**
 * index.html draws the header and a message box before this script loads. The boot page goes once the app draws; the
 * words typed there, with the caret, move to the first message box the app shows (which can come a render later).
 */
function handOffBoot(root: HTMLElement) {
  const boot = document.getElementById("workbot-boot")
  if (!boot) return
  const typed = boot.querySelector("textarea")
  let draft: { text: string; start: number; end: number; focused: boolean } | null = null
  const observer = new MutationObserver(() => {
    if (!root.firstElementChild) return
    if (boot.isConnected) {
      const focused = document.activeElement === typed
      draft = typed && (typed.value || focused) ? { text: typed.value, start: typed.selectionStart, end: typed.selectionEnd, focused } : null
      boot.remove()
    }
    if (!draft) { observer.disconnect(); return }
    const box = Array.from(root.querySelectorAll<HTMLTextAreaElement>("[data-workbot-composer] textarea")).find(node => node.offsetParent !== null && !node.disabled)
    if (!box) return
    observer.disconnect()
    if (draft.text && !box.value) {
      // Through the element's own setter and an input event, so React's onChange sees it as typing.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, draft.text)
      box.dispatchEvent(new Event("input", { bubbles: true }))
    }
    if (draft.focused) {
      box.focus()
      box.setSelectionRange(draft.start, draft.end)
    }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled", "style"] })
  // Words typed before a sign-in redirect or an error page have no message box to go to.
  setTimeout(() => observer.disconnect(), 15_000)
}

const root = document.getElementById("root")
if (root) {
  handOffBoot(root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}
