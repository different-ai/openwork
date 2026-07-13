"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, Plug } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { capturePosthogEvent } from "../lib/posthog-client";
import {
  ANY_CLIENT_COMMAND,
  CHATGPT_SETTINGS_URL,
  CLAUDE_CODE_COMMAND,
  CODEX_COMMAND,
  CODEX_CONNECTIONS_DEEPLINK,
  CODEX_LOGIN_COMMAND,
  CODEX_RECONNECT_COMMAND,
  CONNECT_CLIENTS,
  CONNECT_CLIENT_SUPPORT,
  CURSOR_SNIPPET,
  MCP_SERVER_URL,
  OPENCODE_AUTH_COMMAND,
  OPENCODE_RECONNECT_COMMAND,
  OPENCODE_SNIPPET,
  VS_CODE_COMMAND,
} from "./openwork-connect-installer-config";
import type { OpenWorkConnectClientId } from "./openwork-connect-installer-config";

const DOCS_URL = "https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp#connect-mcp-install-opencode";
const SIGNUP_URL = "https://app.openworklabs.com?mode=sign-up";

type CopyMethod = "clipboard" | "execCommand" | "none";
type ClientId = OpenWorkConnectClientId;

type ClientInstall = {
  id: ClientId;
  label: string;
  eyebrow: string;
  copyText: string;
  helper: string;
  authText?: string;
  reconnectText?: string;
};

const CLIENT_ORDER: ClientId[] = CONNECT_CLIENTS;
const revealSteps = ["Create your free account or sign in", "Pick your org", "Your team's tools appear"];
const CURSOR_ICON_PATH = "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z";
const CLAUDE_ICON_PATH = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const VS_CODE_ICON_PATH = "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z";

const clientIconClass: Record<ClientId, string> = {
  cursor: "text-[#111111]",
  codex: "text-[#111111]",
  "chatgpt-desktop": "text-[#10A37F]",
  "claude-code": "text-[#D97757]",
  opencode: "text-[#656363]",
  "vs-code": "text-[#007ACC]",
  "any-client": "text-gray-500"
};

const CLIENT_INSTALLS: Record<ClientId, ClientInstall> = {
  cursor: {
    id: "cursor",
    label: "Cursor",
    eyebrow: "Cursor Web/Agents HTTPS callback",
    copyText: CURSOR_SNIPPET,
    helper: "Setup-only for Cursor Web/Agents with its HTTPS OAuth callback. Cursor Desktop OAuth uses cursor://anysphere.cursor-mcp/oauth/callback, which OpenWork's MCP profile intentionally rejects."
  },
  codex: {
    id: "codex",
    label: "Codex",
    eyebrow: "Codex desktop, CLI, and IDE",
    copyText: CODEX_COMMAND,
    helper: "Add OpenWork once, then sign in with Codex's MCP login command.",
    authText: CODEX_LOGIN_COMMAND,
    reconnectText: CODEX_RECONNECT_COMMAND
  },
  "chatgpt-desktop": {
    id: "chatgpt-desktop",
    label: "ChatGPT Desktop",
    eyebrow: "Guided desktop setup",
    copyText: MCP_SERVER_URL,
    helper: "Open ChatGPT Settings > MCP servers, paste this URL, then start OAuth from ChatGPT's connection prompt."
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    eyebrow: "One terminal command",
    copyText: CLAUDE_CODE_COMMAND,
    helper: "Add the remote HTTP server, then use /mcp in Claude Code and follow the client auth flow."
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    eyebrow: "opencode.json MCP config",
    copyText: OPENCODE_SNIPPET,
    helper: "Add this remote MCP server entry to your OpenCode config, then authenticate.",
    authText: OPENCODE_AUTH_COMMAND,
    reconnectText: OPENCODE_RECONNECT_COMMAND
  },
  "vs-code": {
    id: "vs-code",
    label: "VS Code",
    eyebrow: "VS Code MCP command",
    copyText: VS_CODE_COMMAND,
    helper: "Run this from a shell with the VS Code CLI on your path, then start OAuth from VS Code's MCP server prompt."
  },
  "any-client": {
    id: "any-client",
    label: "Any client",
    eyebrow: "Bring your own MCP client",
    copyText: ANY_CLIENT_COMMAND,
    helper: "Paste this URL only into clients that support remote Streamable HTTP MCP servers and OAuth."
  }
};

function ClientIcon({ clientId, className }: { clientId: ClientId; className: string }) {
  if (clientId === "codex") {
    return <Image className={`${className} rounded-[3px]`} src="/connect-icons/codex.png" width={20} height={20} alt="" data-product-icon="codex" />;
  }

  if (clientId === "chatgpt-desktop") {
    return <Image className={`${className} rounded-[3px]`} src="/connect-icons/chatgpt.png" width={20} height={20} alt="" data-product-icon="chatgpt" />;
  }

  if (clientId === "cursor") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d={CURSOR_ICON_PATH} />
      </svg>
    );
  }

  if (clientId === "claude-code") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={CLAUDE_ICON_PATH} />
      </svg>
    );
  }

  if (clientId === "opencode") {
    return (
      <svg className={className} viewBox="0 6 24 30" fill="none" aria-hidden="true">
        <path d="M18 30H6V18H18V30Z" fill="#CFCECD" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="currentColor" />
      </svg>
    );
  }

  if (clientId === "vs-code") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={VS_CODE_ICON_PATH} />
      </svg>
    );
  }

  return <Plug className={className} size={16} aria-hidden="true" />;
}

async function writeClipboardText(text: string): Promise<{ copied: boolean; method: CopyMethod }> {
  let copied = false;
  let method: CopyMethod = "none";

  try {
    await navigator.clipboard.writeText(text);
    copied = true;
    method = "clipboard";
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:absolute;left:-9999px;top:-9999px;";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      copied = document.execCommand("copy");
      if (copied) method = "execCommand";
    } catch {}
    textarea.remove();
  }

  return { copied, method };
}

export function LandingConnectMcp() {
  const [activeClient, setActiveClient] = useState<ClientId>("cursor");
  const [feedbackClient, setFeedbackClient] = useState<ClientId | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const installResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (installResetTimer.current) clearTimeout(installResetTimer.current);
      if (urlResetTimer.current) clearTimeout(urlResetTimer.current);
    };
  }, []);

  const copyInstall = async (install: ClientInstall) => {
    const { copied, method } = await writeClipboardText(install.copyText);

    setCopyError(!copied);
    setFeedbackClient(install.id);
    if (copied) setRevealed(true);
    capturePosthogEvent("landing_connect_mcp_copy_clicked", {
      client: install.id,
      copied,
      method
    });

    if (installResetTimer.current) clearTimeout(installResetTimer.current);
    installResetTimer.current = setTimeout(() => {
      setFeedbackClient(null);
      installResetTimer.current = null;
    }, 2500);
  };

  const copyServerUrl = async () => {
    const { copied } = await writeClipboardText(MCP_SERVER_URL);
    setUrlCopied(copied);

    if (urlResetTimer.current) clearTimeout(urlResetTimer.current);
    urlResetTimer.current = setTimeout(() => {
      setUrlCopied(false);
      urlResetTimer.current = null;
    }, 2500);
  };

  return (
    <section id="connect-mcp" className="landing-shell rounded-[2.5rem] p-8 md:p-12 scroll-mt-24">
      <div className="mb-10">
        <div className="mb-4 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
          <Plug size={18} />
          OpenWork Connect
        </div>
        <h2 className="max-w-3xl text-3xl font-medium leading-[1.15] tracking-tight md:text-4xl lg:text-5xl">
          Already doing it in your agent?<br />Add it to OpenWork. Share it with everyone.
        </h2>
        <p className="mt-5 max-w-3xl text-[16px] leading-7 text-gray-600 md:text-lg md:leading-8">
          Skills and MCPs move in as-is — same SKILL.md format, same server URLs. Share once,
          and your whole team runs them in OpenWork — or from their own agent.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-stretch">
        <div
          data-testid="connect-mcp-bring"
          className="flex h-full min-h-[430px] flex-col overflow-hidden rounded-xl border border-[#0b1f34] bg-[#011627] shadow-[0_24px_70px_-44px_rgba(1,22,39,0.85)]"
        >
          <div className="flex items-center gap-3 border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
            <div className="flex gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
              <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
              <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
            </div>
            <div className="text-[12px] font-medium text-gray-300">agent — terminal</div>
          </div>

          <div className="flex flex-1 flex-col gap-4 p-4 font-mono text-[12px] leading-6 text-gray-100 md:p-5">
            <div>
              <span className="text-cyan-300">❯</span> share my skills and MCPs with my OpenWork org
            </div>

            <div className="space-y-2">
              <div>
                <span className="text-green-300">✓</span> found <span className="text-teal-300">granola</span> MCP
              </div>
              <div>
                <span className="text-green-300">✓</span> packed <span className="text-amber-300">meeting-brief</span> skill from SKILL.md
              </div>
              <div>
                <span className="text-green-300">✓</span> added <span className="text-violet-300">review-pr</span> command
              </div>
            </div>

            <div>
              <div className="text-gray-500">› bundling</div>
              <div className="space-y-1 pl-4 text-gray-400">
                <div>mcp/granola.json</div>
                <div>skills/meeting-brief/SKILL.md</div>
                <div>commands/review-pr.md</div>
              </div>
            </div>

            <div className="mt-auto">
              <span className="text-green-300">✓</span> Shared with your org — <span className="text-white">one link</span> for the whole team
            </div>
          </div>
        </div>

        <div
          data-testid="connect-mcp-example"
          className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
        >
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/80 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
                <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
              </div>
              <div className="text-[12px] font-medium text-gray-500">OpenWork</div>
            </div>
            <div className="text-[11px] text-gray-400">Your teammate&apos;s view</div>
          </div>

          <div className="flex flex-1">
            <div className="flex flex-1 flex-col">
              <div className="flex flex-1 flex-col gap-4 p-4">
                <div className="self-end rounded-2xl rounded-br-md bg-gray-100 px-4 py-2.5 text-[12px] leading-relaxed text-[#011627]">
                  Prep a brief for tomorrow&apos;s Acme call from my meeting notes.
                </div>

                <div className="flex flex-col gap-1 pl-1">
                  <div className="text-[10px] text-gray-400">
                    &rsaquo; Queried the shared Granola MCP for meeting notes
                  </div>
                  <div className="text-[10px] text-gray-400">
                    &rsaquo; Ran Meeting Brief Generator — shared by your team
                  </div>
                </div>

                <div className="text-[12px] leading-relaxed text-[#011627]">
                  Your brief is ready — deal history, latest notes, and 3 talking points. Saved to your desktop.
                </div>
              </div>

              <div className="border-t border-gray-100 p-3">
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2">
                  <span className="text-[12px] text-gray-400">Describe your task</span>
                  <span className="rounded-full bg-[#011627] px-3 py-1 text-[10px] font-medium text-white">Run Task</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        id="connect-mcp-install"
        data-testid="connect-mcp-install"
        className="mt-8 border-t border-gray-100 pt-6"
      >
        <div className="group mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="text-[13px] text-gray-500">
            Developers: point your own agent at your org — verified clients and setup guides.
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-2 text-gray-400">
            <Plug size={14} aria-hidden="true" />
            <span className="text-xs text-gray-400">
              Verified for OpenCode only; setup guides for Codex, Cursor, ChatGPT, Claude Code, VS Code, and more
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <div
            role="tablist"
            aria-label="OpenWork MCP client install options"
            className="landing-chip mb-4 flex flex-nowrap gap-1 overflow-x-auto rounded-full p-1"
          >
            {CLIENT_ORDER.map((clientId) => {
              const client = CLIENT_INSTALLS[clientId];
              const selected = client.id === activeClient;

              return (
                <button
                  key={client.id}
                  id={`connect-mcp-tab-${client.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`connect-mcp-panel-${client.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveClient(client.id)}
                  className={`relative shrink-0 cursor-pointer whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                    selected ? "text-[#011627]" : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {selected ? (
                    <motion.div
                      layoutId="connect-mcp-pill"
                      className="absolute inset-0 rounded-full border border-gray-100 bg-white shadow-sm"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  ) : null}
                  <span className="relative z-10 flex items-center gap-2">
                    <ClientIcon clientId={client.id} className={`h-4 w-4 shrink-0 ${clientIconClass[client.id]}`} />
                    <span>{client.label}</span>
                  </span>
                </button>
              );
            })}
          </div>

            {CLIENT_ORDER.map((clientId) => {
              const install = CLIENT_INSTALLS[clientId];
              const support = CONNECT_CLIENT_SUPPORT[clientId];
              const selected = install.id === activeClient;
              const installFeedback = feedbackClient === install.id;

              return (
                <div
                  key={install.id}
                  id={`connect-mcp-panel-${install.id}`}
                  role="tabpanel"
                  aria-labelledby={`connect-mcp-tab-${install.id}`}
                  hidden={!selected}
                  data-feedback={installFeedback ? "true" : "false"}
                  data-copy-error={copyError ? "true" : "false"}
                  data-support-status={support.status}
                >
                  <div>
                    <div className="pb-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                        {install.eyebrow}
                      </div>
                      <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h3 className="flex items-center gap-2 text-xl font-medium text-[#011627]">
                            <ClientIcon clientId={install.id} className={`h-5 w-5 shrink-0 ${clientIconClass[install.id]}`} />
                            <span>{install.label}</span>
                          </h3>
                          <p className="mt-1 text-[13px] leading-5 text-gray-500">{install.helper}</p>
                          <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                            <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${support.status === "Verified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                              {support.status}
                            </span>
                            <span className="text-[12px] leading-5 text-gray-500">{support.explanation}</span>
                          </div>
                        </div>
                        {install.id === "codex" ? (
                          <a
                            href={CODEX_CONNECTIONS_DEEPLINK}
                            onClick={() => {
                              void writeClipboardText(MCP_SERVER_URL);
                            }}
                            className="inline-flex min-h-[42px] shrink-0 items-center justify-center rounded-full bg-[#011627] px-5 text-sm font-medium text-white shadow-[0_14px_32px_-16px_rgba(1,22,39,0.55)] transition-colors hover:bg-black"
                          >
                            {urlCopied ? "Copied URL" : "Open settings + copy URL"}
                          </a>
                        ) : install.id === "chatgpt-desktop" ? (
                          <a
                            href={CHATGPT_SETTINGS_URL}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => {
                              void copyServerUrl();
                            }}
                            className="inline-flex min-h-[42px] shrink-0 items-center justify-center rounded-full bg-[#011627] px-5 text-sm font-medium text-white shadow-[0_14px_32px_-16px_rgba(1,22,39,0.55)] transition-colors hover:bg-black"
                          >
                            Open settings + copy URL
                          </a>
                        ) : null}
                      </div>
                    </div>

                    <div>
                      <pre className="max-h-[300px] overflow-x-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 font-mono text-[12px] leading-6 text-white shadow-inner">
                        <code>{install.copyText}</code>
                      </pre>
                      {install.id === "any-client" ? (
                        <p className="mt-3 text-[13px] leading-6 text-gray-500">
                          Use this URL only with MCP clients that support remote Streamable HTTP servers with OAuth.
                        </p>
                      ) : null}
                      {install.authText ? (
                        <div className="mt-3">
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                            Authenticate
                          </div>
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 font-mono text-[12px] leading-6 text-white shadow-inner">
                            <code>{install.authText}</code>
                          </pre>
                        </div>
                      ) : null}
                      {install.reconnectText ? (
                        <div className="mt-3">
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                            Reconnect or switch org
                          </div>
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 font-mono text-[12px] leading-6 text-white shadow-inner">
                            <code>{install.reconnectText}</code>
                          </pre>
                        </div>
                      ) : null}
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-[12px] leading-5 text-gray-500">
                          Works with your OpenWork account —{" "}
                          <a
                            href={SIGNUP_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-[#011627] underline decoration-gray-300 underline-offset-4 hover:decoration-[#011627]"
                          >
                            create one free
                          </a>
                          .
                        </p>
                        <button
                          type="button"
                          aria-label="Copy the OpenWork MCP install command"
                          onClick={() => {
                            void copyInstall(install);
                          }}
                          className="inline-flex min-w-[110px] items-center justify-center gap-1.5 rounded-lg bg-[#011627] px-4 py-2 text-xs font-medium text-white shadow-[0_1px_2px_rgba(17,24,39,0.12)] transition-colors hover:bg-black"
                        >
                          {installFeedback ? (
                            copyError ? (
                              "Couldn't copy"
                            ) : (
                              <>
                                <svg
                                  className="h-3.5 w-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                                Copied
                              </>
                            )
                          ) : (
                            "Copy"
                          )}
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                        {revealed && selected ? (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.25 }}
                            className="overflow-hidden"
                          >
                            <div className="mt-3 border-t border-gray-100 pt-3">
                              <div className="flex items-center gap-2 text-[13px] font-medium text-[#011627]">
                                <svg
                                  className="h-4 w-4 shrink-0 text-green-600"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                                Copied — now run it:
                              </div>
                              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
                                {revealSteps.map((label, index) => (
                                  <div key={label} className="flex items-center gap-2">
                                    {index > 0 ? <ChevronRight size={12} className="text-gray-300" /> : null}
                                    <span className="step-circle">{index + 1}</span>
                                    <span className="text-[13px] text-gray-600">{label}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  </div>
                  <span aria-live="polite" className="sr-only">
                    {installFeedback ? (copyError ? "Install command could not be copied" : "Install command copied") : ""}
                  </span>
                </div>
              );
            })}
          </div>

        <div className="mt-5 flex flex-col gap-2 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
            Server URL
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <code className="min-w-0 whitespace-normal break-all rounded bg-gray-50 px-2 py-1 font-mono text-[12px] text-[#011627]">
              {MCP_SERVER_URL}
            </code>
            <button
              type="button"
              aria-label="Copy the OpenWork MCP server URL"
              onClick={() => {
                void copyServerUrl();
              }}
              className="inline-flex shrink-0 items-center justify-center px-2 py-1 text-xs font-medium text-[#011627] underline decoration-gray-300 underline-offset-4 transition-colors hover:decoration-[#011627]"
            >
              {urlCopied ? "Copied" : "Copy URL"}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3 border-t border-gray-100 pt-5 text-[13px] leading-6 text-gray-600 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Verified in OpenCode. Codex and other setup guides require remote Streamable HTTP MCP and OAuth
          support — your agent signs in with your OpenWork account, and access is scoped by org membership, roles, policies, and exposure allowlists.
        </p>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-medium text-[#011627] underline decoration-gray-300 underline-offset-4 transition-colors hover:decoration-[#011627]"
        >
          Read the docs
        </a>
      </div>
    </section>
  );
}
