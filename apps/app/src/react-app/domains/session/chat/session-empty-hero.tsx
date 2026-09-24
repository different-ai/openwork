/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { AutoFirstUseStatus, openAutoSignIn } from "../../cloud/auto-access-ui";
import { isAutoModel } from "@/react-app/domains/models/model-catalog";
import type { ComposerAttachment } from "@/app/types";
import { resolveOrganizationPromptCardContent } from "@/components/chat/task-suggestions";
import { useCheckDesktopRestriction, useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { persistableComposerDraftText, useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store";
import { useNewTaskDraftState } from "@/react-app/domains/session/sync/draft-store";
import {
  NewTaskComposer,
  type NewTaskComposerContext,
  type NewTaskComposerHandoff,
} from "./new-task-composer";
import { consumePendingChatSeed, pendingChatSeedEvent } from "./pending-chat-seed";
import { hideEmptyHeroIntroduction } from "./empty-hero-introduction";

type HeroSuggestion = {
  title: string;
  description: string;
  prompt: string;
};

const DEFAULT_SUGGESTIONS: HeroSuggestion[] = [
  { title: "Summarize this folder", description: "Summarize the files in this workspace.", prompt: "Summarize the files in this folder and highlight what needs my attention." },
  { title: "Find TODOs and open questions", description: "Find outstanding work in this folder.", prompt: "Find TODOs and open questions in this folder. Summarize the outstanding work and link to the relevant files." },
  { title: "Draft a release note", description: "Draft a release note from this workspace.", prompt: "Draft a release note from the changes in this workspace. Ask me if the release scope is unclear." },
];

export type SessionEmptyHeroProps = {
  providerCount: number;
  /** Disable submission while a default workspace is being prepared. */
  busy?: boolean;
  /** Called with the task prompt and attachments; the caller creates the session (and workspace if needed). */
  onRunTask: (
    prompt: string,
    attachments: ComposerAttachment[],
    handoff?: NewTaskComposerHandoff,
  ) => void | Promise<void>;
  onOpenProviderAuth?: () => void;
  /** Workspace-scoped wiring for the full composer (skills, agents, models). */
  composer?: NewTaskComposerContext | null;
};

export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  // The session is created on submit, so until then the prompt has no
  // conversation to live in. Persist it under the workspace's reserved slot so
  // opening another session (or restarting) does not lose it; the sidebar
  // offers a Draft row for the same slot. The parent keys this component by
  // draft owner, so the initial read is the only hydration needed.
  const persistedDraft = useNewTaskDraftState(props.composer?.draftScope, props.composer?.workspaceId, props.composer?.draftSessionId);
  const [prompt, setPromptState] = useState(() => (
    props.composer?.draftOwnerKey ? useComposerStateStore.getState().sessions[props.composer.draftOwnerKey]?.draft : undefined
  ) ?? persistedDraft.snapshot?.text ?? "");
  const promptRef = useRef(prompt);
  // Once a send is in flight the composer has cleared the slot, and anything
  // typed until its route lands is carried into the created session as the
  // continuation. Persisting it here would pre-fill the next new task. On
  // success this hero unmounts, so the flag only resets when the send fails.
  const sendInFlightRef = useRef(false);
  const [sendInFlight, setSendInFlight] = useState(false);
  const [composing, setComposing] = useState(false);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const hideIntroduction = hideEmptyHeroIntroduction(isMobile, composing, prompt, sendInFlight || Boolean(props.busy));

  useEffect(() => {
    // A null blur target can be keyboard dismissal or a touch send. Only a
    // deliberate interaction outside the dock ends composition, never blur.
    const leaveComposer = (event: Event) => {
      if (event.target instanceof Node && !composerDockRef.current?.contains(event.target)) {
        setComposing(false);
      }
    };
    document.addEventListener("pointerdown", leaveComposer);
    document.addEventListener("focusin", leaveComposer);
    return () => {
      document.removeEventListener("pointerdown", leaveComposer);
      document.removeEventListener("focusin", leaveComposer);
    };
  }, []);
  const persistPrompt = persistedDraft.save;
  const setPrompt = useCallback((value: string) => {
    setPromptState(value);
    promptRef.current = value;
    if (sendInFlightRef.current) return;
    // Attachment chips only exist in memory (File objects); the stored text drops their tokens.
    persistPrompt({ text: persistableComposerDraftText(value), mode: "prompt" });
  }, [persistPrompt]);
  const orgRestrictions = useOrgRestrictions();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });
  const denAuth = useDenAuth();

  // A chat deep link (Den's connector "Chat" action) seeds the composer with
  // the connector chip and its starter prompt; the person reviews and sends.
  useEffect(() => {
    const seed = () => {
      const draft = consumePendingChatSeed();
      if (draft === null) return;
      setPrompt(draft);
      window.dispatchEvent(new Event("openwork:focusPrompt"));
    };
    seed();
    window.addEventListener(pendingChatSeedEvent, seed);
    return () => window.removeEventListener(pendingChatSeedEvent, seed);
  }, []);

  const showAutoStatus = denAuth.status === "signed_out" && isAutoModel(props.composer?.selectedModel) && !props.composer?.modelUnavailable;

  const organizationPrompts = orgRestrictions.onboardingPrompts;
  const suggestions: HeroSuggestion[] = organizationPrompts !== undefined
    ? organizationPrompts.map((orgPrompt, index) => {
      const card = resolveOrganizationPromptCardContent({
        prompt: orgPrompt,
        description: orgRestrictions.onboardingPromptDescriptions?.[index],
        index,
      });
      return { title: card.title, description: card.description, prompt: card.selectionPrompt };
    })
    : DEFAULT_SUGGESTIONS;

  const submit = async (
    resolvedPrompt: string,
    attachments: ComposerAttachment[],
    handoff?: NewTaskComposerHandoff,
  ) => {
    const trimmedPrompt = resolvedPrompt.trim();
    if ((!trimmedPrompt && !attachments.length) || props.busy) return;
    sendInFlightRef.current = true;
    setSendInFlight(true);
    // Legacy callers may not establish a pending conversation. Clear only after
    // their submit starts; the synchronous consume callback owns the new pipeline.
    try {
      const work = props.onRunTask(trimmedPrompt, attachments, handoff);
      persistedDraft.clear();
      await work;
    } catch (error) {
      // The composer stays on this route, so whatever it holds now is once
      // again the unsent new-task prompt and must stay reachable.
      sendInFlightRef.current = false;
      setSendInFlight(false);
      persistPrompt({ text: persistableComposerDraftText(promptRef.current), mode: "prompt" });
      throw error;
    }
  };

  const fillPrompt = (value: string) => {
    setPrompt(value);
    window.dispatchEvent(new Event("openwork:focusPrompt"));
  };

  return (
    <div data-chat-empty-hero className={`mx-auto flex h-full min-h-0 w-full flex-1 flex-col gap-6 px-8 pb-4 max-lg:gap-4 max-lg:overflow-y-auto max-lg:px-3 max-lg:pb-[max(0.5rem,env(safe-area-inset-bottom))] ${props.composer?.destination?.parent ? "" : "lg:absolute lg:inset-0"}`}>
      <div data-empty-introduction hidden={hideIntroduction} className={hideIntroduction ? "hidden" : "flex min-h-56 w-full max-w-[800px] flex-1 flex-col items-center justify-center gap-5 self-center py-12 text-center"}>
        <div data-empty-greeting hidden={hideIntroduction} className="space-y-1.5">
          <h2 className="text-xl font-bold leading-7 tracking-tight text-foreground">What should we work on?</h2>
          <p className="text-sm leading-5 text-muted-foreground">{props.composer?.workspaceId ? "Describe it in plain language. OpenWork works on the files in this folder." : "Describe a task in plain language to start a conversation."}</p>
        </div>
        <div data-empty-suggestions hidden={hideIntroduction} className="flex flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => <Button key={suggestion.title} variant="outline" size="sm" className="min-h-8 rounded-full px-3 text-sm max-lg:min-h-11"
            aria-label={`${suggestion.title}: ${suggestion.description}`} onClick={() => fillPrompt(suggestion.prompt)}>{suggestion.title}</Button>)}
        </div>
        {showAutoStatus ? <AutoFirstUseStatus onConnect={canAddProviders ? props.onOpenProviderAuth : undefined} /> : null}
        {!showAutoStatus && canAddProviders && props.providerCount === 0 && props.onOpenProviderAuth ? <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>Connect a provider to get started.</span><Button variant="outline" size="sm" onClick={props.onOpenProviderAuth}>Connect a model provider</Button>
        </div> : null}
      </div>
      <div ref={composerDockRef} onFocusCapture={() => setComposing(true)} data-empty-composer-dock className="mt-auto w-full max-w-[800px] shrink-0 self-center max-lg:sticky max-lg:bottom-0 max-lg:order-last max-lg:mt-auto max-lg:shrink-0 max-lg:bg-dls-surface">
        <NewTaskComposer draft={prompt} onDraftChange={setPrompt} onRunTask={submit} busy={props.busy ?? false} context={props.composer ?? null} />
        {denAuth.status === "signed_out" ? <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="first-use-local-caption">
          {props.composer?.isRemoteWorkspace || props.composer?.isSandboxWorkspace ? "Files stay in this workspace. " : "Files stay on this device. "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => openAutoSignIn()}>Sign in to OpenWork Cloud</button> to sync your Library.
        </p> : null}
      </div>
    </div>
  );
}
