/** @jsxImportSource react */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Streamdown } from "streamdown";

function MarkdownCodeBlock(props: { className?: string; children: React.ReactNode }) {
  const text = Array.isArray(props.children) ? props.children.join("") : String(props.children ?? "");
  const [copied, setCopied] = useState(false);

  return (
    <div className="my-4 overflow-hidden rounded-[18px] border border-dls-border/70 bg-gray-1/80">
      <div className="flex items-center justify-end border-b border-dls-border/70 px-3 py-2">
        <button
          type="button"
          className="rounded-full border border-dls-border bg-dls-surface px-3 py-1 text-[11px] font-medium text-dls-text transition-colors hover:bg-dls-hover"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[12px] leading-6 text-gray-12">
        <code className={props.className}>{props.children}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]"
      >
        {children}
      </a>
    );
  },
  pre({ children }) {
    return (
      <pre className="my-4 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/80 px-4 py-3 text-[12px] leading-6 text-gray-12">
        {children}
      </pre>
    );
  },
  code({ className, children }) {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return <MarkdownCodeBlock className={className}>{children}</MarkdownCodeBlock>;
    }
    return (
      <code className="rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-[0.92em] text-gray-12">
        {children}
      </code>
    );
  },
  blockquote({ children }) {
    return <blockquote className="my-4 border-l-4 border-dls-border pl-4 italic text-gray-11">{children}</blockquote>;
  },
  table({ children }) {
    return <table className="my-4 w-full border-collapse">{children}</table>;
  },
  th({ children }) {
    return <th className="border border-dls-border bg-dls-hover p-2 text-left">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-dls-border p-2 align-top">{children}</td>;
  },
  hr() {
    return <hr className="my-6 border-none h-px bg-gray-4" />;
  },
};

const markdownClassName = `markdown-content max-w-none text-gray-12
  [&_strong]:font-semibold
  [&_em]:italic
  [&_h1]:my-5 [&_h1]:text-xl [&_h1]:font-semibold
  [&_h2]:my-4 [&_h2]:text-lg [&_h2]:font-semibold
  [&_h3]:my-3 [&_h3]:text-base [&_h3]:font-semibold
  [&_p]:my-3 [&_p]:leading-relaxed
  [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6
  [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6
  [&_li]:my-1
`.trim();

export function MarkdownBlock(props: { text: string; streaming?: boolean }) {
  if (!props.text.trim()) return null;

  if (props.streaming) {
    return (
      <div className={markdownClassName}>
        <Streamdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
          {props.text}
        </Streamdown>
      </div>
    );
  }

  return (
    <div className={markdownClassName}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
