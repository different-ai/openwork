/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isElectronRuntime } from "../../../../app/utils";

type TerminalDockProps = {
  workspaceRoot: string;
  isRemoteWorkspace: boolean;
  onClose: () => void;
};

export function TerminalDock({ workspaceRoot, isRemoteWorkspace, onClose }: TerminalDockProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState("Starting terminal...");

  useEffect(() => {
    if (!containerRef.current) return;
    if (!isElectronRuntime()) {
      setStatus("Terminal is available in the desktop app.");
      return;
    }
    if (isRemoteWorkspace) {
      setStatus("Remote workspace terminals are not wired yet.");
      return;
    }

    const bridge = window.__OPENWORK_ELECTRON__?.terminal;
    if (!bridge?.create || !bridge.write || !bridge.resize || !bridge.kill || !bridge.onData || !bridge.onExit) {
      setStatus("Terminal bridge is unavailable.");
      return;
    }
    const createTerminal = bridge.create;
    const writeTerminal = bridge.write;
    const resizeTerminal = bridge.resize;
    const killTerminal = bridge.kill;
    const onTerminalData = bridge.onData;
    const onTerminalExit = bridge.onExit;

    let disposed = false;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', Menlo, monospace",
      fontSize: 12,
      theme: {
        background: "#0b0d12",
        foreground: "#d7dde8",
        cursor: "#ffffff",
        selectionBackground: "#334155",
      },
    });
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminal.focus();
    fitAddon.fit();
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const removeDataListener = onTerminalData(({ terminalId, data }) => {
      if (terminalIdRef.current !== terminalId) return;
      terminal.write(data);
    });
    const removeExitListener = onTerminalExit(({ terminalId, exitCode }) => {
      if (terminalIdRef.current !== terminalId) return;
      setStatus(`Terminal exited${exitCode === null ? "" : ` with code ${exitCode}`}.`);
      terminalIdRef.current = null;
    });
    const inputDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      void writeTerminal(terminalId, data);
    });

    const fitAndResize = () => {
      fitAddon.fit();
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      void resizeTerminal(terminalId, terminal.cols, terminal.rows);
    };
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(containerRef.current);

    void createTerminal({ cwd: workspaceRoot, cols: terminal.cols, rows: terminal.rows }).then(({ terminalId }) => {
      if (disposed) {
        void killTerminal(terminalId);
        return;
      }
      terminalIdRef.current = terminalId;
      setStatus(workspaceRoot);
      fitAndResize();
    }).catch((error) => {
      setStatus(error instanceof Error ? error.message : "Could not start terminal.");
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      if (terminalId) void killTerminal(terminalId);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [isRemoteWorkspace, workspaceRoot]);

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-border bg-[#0b0d12] text-white" aria-label="Terminal">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 bg-black/35 px-3 text-xs">
        <div className="min-w-0 truncate text-white/75">Terminal · {status}</div>
        <Button variant="ghost" size="icon-sm" className="text-white/70 hover:bg-white/10 hover:text-white" onClick={onClose}>
          <X className="size-4" />
          <span className="sr-only">Hide terminal</span>
        </Button>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 py-1 [&_.xterm]:h-full" />
    </section>
  );
}
