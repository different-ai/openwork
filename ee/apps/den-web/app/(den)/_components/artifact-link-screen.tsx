"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { artifactOpenUrl, type readArtifactLink } from "../_lib/artifact-link";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { MemberAuthCheckError } from "./member-auth-guard";
import { SetupFrame } from "./setup-frame";
import { SetupLine, SetupPanelBody, SetupSkeletonRows } from "./setup-frame-parts";

export function ArtifactLinkScreen({ link }: { link: ReturnType<typeof readArtifactLink> }) {
  const { user, sessionHydrated, memberAuthCheckStatus, runtimeConfigLoaded, runtimeConfig } = useDenFlow();
  const target = runtimeConfigLoaded && link ? artifactOpenUrl({ denApiUrl: runtimeConfig.denApiUrl, ...link }) : null;
  const redirected = useRef(false);

  useEffect(() => {
    if (!sessionHydrated || !user || !target || redirected.current) return;
    redirected.current = true;
    window.location.replace(target);
  }, [sessionHydrated, user, target]);

  function frame(title: string, content: ReactNode) {
    return (
      <SetupFrame single title={title} description="">
        <SetupPanelBody>{content}</SetupPanelBody>
      </SetupFrame>
    );
  }

  if (!link) {
    return frame("This link doesn't work", <SetupLine>Ask the person who sent it to copy the artifact link again.</SetupLine>);
  }
  if (!target && (runtimeConfigLoaded || memberAuthCheckStatus === "error")) {
    return frame("Artifacts can't be opened in a browser on this deployment.", null);
  }
  if (memberAuthCheckStatus === "error") {
    return frame("", <MemberAuthCheckError />);
  }
  if (!sessionHydrated || !target) {
    return frame("Open the artifact", <SetupSkeletonRows count={1} />);
  }
  if (!user) {
    return frame("Sign in to open this artifact", <>
      <SetupLine>A teammate shared an artifact with you. Sign in to OpenWork to see it.</SetupLine>
      <AuthPanel bare hideIntro emailFirstFlow signInOnly />
    </>);
  }
  return frame("Opening the artifact…", (
    <a className="self-start text-sm font-medium underline" href={target}>Open the artifact</a>
  ));
}
