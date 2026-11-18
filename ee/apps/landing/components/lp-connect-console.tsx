"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import { LpCopyButton, LpCopyIcon } from "./lp-copy";
import { MCP_CLIENTS, MCP_SERVER_URL } from "./lp-mcp-clients";

/** URL first, then one exact install step per client. Light surface only (no dark panels). */
export function LpConnectConsole() {
  const [activeId, setActiveId] = useState(MCP_CLIENTS[0].id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = MCP_CLIENTS.find((client) => client.id === activeId) ?? MCP_CLIENTS[0];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % MCP_CLIENTS.length;
    if (event.key === "ArrowLeft") next = (index - 1 + MCP_CLIENTS.length) % MCP_CLIENTS.length;
    if (next < 0) return;
    event.preventDefault();
    setActiveId(MCP_CLIENTS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="rounded-[20px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_16px_40px_-24px_rgba(1,22,39,0.18)]">
      <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:gap-4 sm:py-[22px] sm:pl-7 sm:pr-[22px]">
        <span className="mono hidden text-xs text-[#8A93A0] sm:block">MCP URL</span>
        <code className="mono min-w-0 flex-1 break-all text-[17px] tracking-[-0.01em] text-[var(--lp-ink)] sm:text-[22px]">
          {MCP_SERVER_URL}
        </code>
        <LpCopyButton value={MCP_SERVER_URL} className="self-start sm:self-auto" />
      </div>
      <div className="h-px bg-[#EEF0F3]" />
      <div role="tablist" aria-label="MCP clients" className="flex gap-1 overflow-x-auto px-4 py-3">
        {MCP_CLIENTS.map((client, index) => {
          const selected = client.id === active.id;
          return (
            <button
              key={client.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`client-tab-${client.id}`}
              aria-selected={selected}
              aria-controls="client-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(client.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`flex h-8 shrink-0 items-center gap-[7px] rounded-lg px-3 text-[13px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--lp-ink)] ${
                selected ? "bg-[var(--lp-tonal)] font-medium text-[var(--lp-ink)]" : "text-[var(--lp-muted)] hover:text-[var(--lp-ink)]"
              }`}
            >
              {client.mark}
              {client.name}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="client-panel"
        aria-labelledby={`client-tab-${active.id}`}
        className="mx-4 mb-4 flex flex-col gap-2.5 rounded-xl bg-[#F5F7FA] px-4 py-3.5"
      >
        {active.command ? (
          <div className="flex items-center gap-3">
            <span className="mono text-sm text-[#8A93A0]" aria-hidden="true">$</span>
            <code className="mono min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[13px] text-[var(--lp-ink)] sm:text-sm">
              {active.command}
            </code>
            <LpCopyIcon value={active.command} label={`Copy the ${active.name} command`} />
          </div>
        ) : null}
        {active.link ? (
          <div>
            <a href={active.link.href} className="lp-pill-primary lp-pill-sm">
              {active.link.label}
            </a>
          </div>
        ) : null}
        <p className="mono text-[13px] text-[#6B7280]"># {active.next}</p>
      </div>
    </div>
  );
}
