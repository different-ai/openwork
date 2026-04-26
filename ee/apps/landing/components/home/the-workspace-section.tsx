import BubbleButton from "@/components/ui/bubble-button";
import Eyebrow from "@/components/ui/eyebrow";
import { DOWNLOAD_URL } from "@/constants";

const TheWorkspaceSection = () => {
  return (
    <section className="px-(--container-px)">
      <div className="grid-12 mx-auto max-w-[140rem] items-end gap-y-[4.8rem]">
        {/* Left — copy column */}
        <div className="col-span-12 md:col-span-4 md:sticky md:top-[14rem] flex flex-col gap-base-lg">
          <Eyebrow>The Workspace</Eyebrow>
          <h2 className="text-[4.4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.6rem]">
            <span className="font-sans font-bold">Your machine,</span>
            <br />
            <span className="font-serif font-light italic">your audit log.</span>
          </h2>
          <p className="font-sans text-[1.6rem] font-medium leading-[1.55] text-foreground/65">
            Sessions stream live. Plans render as a timeline. Every permission request is explicit. Your folders stay
            yours unless you say otherwise.
          </p>
          <ul className="gap-sm flex flex-col font-sans text-[1.4rem] font-medium text-foreground/70">
            <li className="border-foreground/10 border-b py-sm">→ macOS keychain stores tokens</li>
            <li className="border-foreground/10 border-b py-sm">→ Folder-level allow/deny gate</li>
            <li className="border-foreground/10 border-b py-sm">→ Exportable session logs</li>
            <li className="py-sm">→ Eject to <code className="font-mono text-[0.9em]">opencode</code> any time</li>
          </ul>
          <div className="pt-sm">
            <BubbleButton isLink href={DOWNLOAD_URL} target="_blank">
              Open the workspace
            </BubbleButton>
          </div>
        </div>

        {/* Right — video frame */}
        <div className="col-span-12 md:col-span-7 md:col-start-6 relative">
          <div className="border-foreground/15 absolute -inset-base rounded-[1.6rem] border border-dashed pointer-events-none" aria-hidden />

          {/* mac-style chrome bar */}
          <div className="terminal-surface relative overflow-hidden rounded-[1.2rem]">
            <div className="term-bar grid grid-cols-[auto_1fr_auto] items-center gap-base px-base py-sm">
              <div className="flex items-center gap-sm">
                <span className="size-[1rem] rounded-full bg-[#ef4444]" />
                <span className="size-[1rem] rounded-full bg-[#eab308]" />
                <span className="size-[1rem] rounded-full bg-[#22c55e]" />
              </div>
              <span className="text-center font-sans text-[1.2rem] font-medium">workspace · preview</span>
              <span className="hidden sm:inline-flex items-center gap-xs font-sans text-[1.1rem] font-medium">
                <span className="bg-emerald-400 size-[0.7rem] rounded-full" />
                <span className="font-serif italic font-light text-[1.3rem]">in your folder</span>
              </span>
            </div>
            <div className="aspect-[16/10] relative bg-black flex items-center justify-center">
              <span className="font-serif italic font-light text-[1.6rem] text-white/40">
                workspace preview coming soon
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default TheWorkspaceSection;
