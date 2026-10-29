// Remote computers for computer use. Each is an existing Linux VM reached
// through its `@openwork/sandbox` provider (run a command, read a file) and
// driven by the X11 driver. Pointing computer use at a VM is configuration:
//
//   OPENWORK_COMPUTER_FREESTYLE_VM=<vm id>        with FREESTYLE_API_KEY
//   OPENWORK_COMPUTER_DAYTONA_SANDBOX=<sandbox id> with DAYTONA_API_KEY (and DAYTONA_API_URL)
//   OPENWORK_COMPUTER_DISPLAY=:99                  the VM's X display (default :99)
//
// Another provider only needs a `machine` binding below. Provider packages load
// lazily, so a desktop without a configured VM never starts their clients.
import { createRemoteComputerAdapter } from "@openwork/computer-use/computer-remote";
import { createX11Driver } from "@openwork/computer-use/computer-x11-driver";

/**
 * @typedef {{ run: (command: string, timeoutMs: number) => Promise<{ exitCode: number, stdout: string, stderr: string }>, read: (path: string, timeoutMs: number) => Promise<Uint8Array> }} Machine
 * @typedef {{ providerId: string, ref: Record<string, string> }} SandboxRef
 * @typedef {{ state: string }} SandboxHandle
 * @typedef {{
 *   get: (ref: SandboxRef) => Promise<SandboxHandle | null>,
 *   blocks?: {
 *     run?: (handle: SandboxHandle, spec: { command: string, timeoutMs: number }) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *     files?: { read: (handle: SandboxHandle, path: string, options: { timeoutMs: number }) => Promise<Uint8Array> },
 *   },
 * }} SandboxProvider
 */

// Provider packages load by name: only the slice above is used, and their
// sources stay out of the desktop's own type check.
const loadProvider = (name) => import(name);

/** Resolves the sandbox handle once, then reuses it; a failed lookup is retried next time. */
function lazyMachine(connect) {
  let pending = null;
  const machine = () => (pending ??= connect().catch((error) => { pending = null; throw error; }));
  return {
    run: async (command, timeoutMs) => (await machine()).run(command, timeoutMs),
    read: async (path, timeoutMs) => (await machine()).read(path, timeoutMs),
  };
}

/**
 * @param {() => Promise<{ provider: SandboxProvider, ref: SandboxRef }>} load
 * @returns {Machine}
 */
function sandboxMachine(load) {
  return lazyMachine(async () => {
    const { provider, ref } = await load();
    const handle = await provider.get(ref);
    if (!handle) throw new Error("The VM was not found. Check its id.");
    if (handle.state !== "running") throw new Error(`The VM is ${handle.state}. Start it and try again.`);
    const run = provider.blocks?.run;
    const files = provider.blocks?.files;
    if (!run || !files) throw new Error("This provider cannot run commands or read files on the VM.");
    return {
      run: (command, timeoutMs) => run(handle, { command, timeoutMs }),
      read: (path, timeoutMs) => files.read(handle, path, { timeoutMs }),
    };
  });
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function remoteComputerAdapters(env = process.env) {
  const display = env.OPENWORK_COMPUTER_DISPLAY?.trim() || ":99";
  const adapters = [];
  const freestyleVm = env.OPENWORK_COMPUTER_FREESTYLE_VM?.trim();
  const freestyleKey = env.FREESTYLE_API_KEY?.trim();
  if (freestyleVm && freestyleKey) {
    adapters.push(createRemoteComputerAdapter({
      id: "freestyle-vm",
      label: env.OPENWORK_COMPUTER_FREESTYLE_LABEL?.trim() || "Freestyle VM",
      driver: createX11Driver({
        display,
        machine: sandboxMachine(async () => {
          const { createFreestyleProvider } = await loadProvider("@openwork/sandbox-freestyle");
          // Only an existing VM is driven; nothing is created, so no snapshot or egress applies.
          const provider = createFreestyleProvider({ apiKey: freestyleKey, snapshot: "", firewall: { rules: [] } });
          return { provider, ref: { providerId: "freestyle", ref: { vmId: freestyleVm } } };
        }),
      }),
    }));
  }
  const daytonaSandbox = env.OPENWORK_COMPUTER_DAYTONA_SANDBOX?.trim();
  const daytonaKey = env.DAYTONA_API_KEY?.trim();
  if (daytonaSandbox && daytonaKey) {
    adapters.push(createRemoteComputerAdapter({
      id: "daytona-sandbox",
      label: env.OPENWORK_COMPUTER_DAYTONA_LABEL?.trim() || "Daytona sandbox",
      driver: createX11Driver({
        display,
        machine: sandboxMachine(async () => {
          const { createDaytonaProvider } = await loadProvider("@openwork/sandbox-daytona");
          const provider = createDaytonaProvider({
            apiKey: daytonaKey,
            apiUrl: env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api",
            ...(env.DAYTONA_TARGET?.trim() ? { target: env.DAYTONA_TARGET.trim() } : {}),
            snapshot: null, image: "", resources: { cpu: 1, memoryGb: 1, diskGb: 1 },
            pollIntervalMs: 1_000, helperCreateTimeoutMs: 60_000,
            // The run block is enabled only for a declared Linux flavor.
            platform: { os: "linux", isolation: "container" },
          });
          return { provider, ref: { providerId: "daytona", ref: { sandboxId: daytonaSandbox } } };
        }),
      }),
    }));
  }
  return adapters;
}
