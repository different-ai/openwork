/** @jsxImportSource react */
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Streamdown } from "streamdown";

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
      return <code className={className}>{children}</code>;
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
};

const markdownClassName = `markdown-content max-w-none text-gray-12
  [&_strong]:font-semibold
  [&_em]:italic
  [&_h1]:my-4 [&_h1]:text-2xl [&_h1]:font-bold
  [&_h2]:my-3 [&_h2]:text-xl [&_h2]:font-bold
  [&_h3]:my-2 [&_h3]:text-lg [&_h3]:font-bold
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
