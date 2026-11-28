import type { LocalComputerServer } from "@/react-app/infra/local-computer-server"

type Credential = { baseUrl: string; token: string }
type RunnerServer = Pick<LocalComputerServer, "identity"> & {
  client: Pick<LocalComputerServer["client"], "putComputerRunner" | "deleteComputerRunner">
}

export function createComputerRunnerDelivery() {
  let server: RunnerServer | null = null
  let credential: Credential | null = null
  let version = 0
  let written: { server: RunnerServer; version: number | null } | null = null
  let queue = Promise.resolve()
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch(() => undefined)
    return queue
  }
  const clear = async () => {
    if (!written) return
    const previous = written.server
    written = null
    await previous.client.deleteComputerRunner().catch(() => undefined)
  }
  const sync = () => enqueue(async () => {
    if (written && server && written.server.identity !== server.identity) await clear()
    if (!server || !credential || written?.version === version) return
    const target = server
    const sentVersion = version
    written = { server: target, version: null }
    await target.client.putComputerRunner(credential)
    written.version = sentVersion
  })
  return {
    setServer(next: RunnerServer | null) {
      server = next
      return sync()
    },
    setCredential(next: Credential | null) {
      credential = next
      version += 1
      return next ? sync() : enqueue(clear)
    },
  }
}
