import { WorkbotScreen } from "@openwork-ee/workbot-ui"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { StrictMode, useEffect, useMemo } from "react"
import { createRoot } from "react-dom/client"
import { createHost, fetchMe, signIn, type Me } from "./host"
import "./styles.css"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })

function Signed({ me }: { me: Me }) {
  const host = useMemo(() => createHost(me), [me])
  return <WorkbotScreen host={host} />
}

function App() {
  const me = useQuery({ queryKey: ["workbot", "me"], queryFn: fetchMe, staleTime: 60_000 })
  const signedOut = me.isSuccess && me.data === null
  useEffect(() => {
    if (signedOut) signIn()
  }, [signedOut])
  if (me.isError) {
    return (
      <main className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm">
          <p className="text-[15px] font-medium text-[#011627]">Workbot can't reach OpenWork right now.</p>
          <button type="button" onClick={() => void me.refetch()} className="mt-4 rounded-full bg-[#011627] px-4 py-2 text-[14px] font-medium text-white">
            Try again
          </button>
        </div>
      </main>
    )
  }
  if (!me.data) return null
  return <Signed me={me.data} />
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
