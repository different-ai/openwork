import WebUnavailableSurface from "../components/web-unavailable-surface";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import ExtensionsView, { type ExtensionsViewProps } from "./extensions";
import IdentitiesView, { type IdentitiesViewProps } from "./identities";
import ScheduledTasksView, { type ScheduledTasksViewProps } from "./scheduled";
import SkillsView, { type SkillsViewProps } from "./skills";

type WorkspaceToolsPanelProps =
  | {
      section: "scheduled";
      scheduled: ScheduledTasksViewProps;
    }
  | {
      section: "skills";
      skills: SkillsViewProps;
    }
  | {
      section: "extensions";
      extensions: ExtensionsViewProps;
    }
  | {
      section: "identities";
      identities: IdentitiesViewProps;
    };

export default function WorkspaceToolsPanel(props: WorkspaceToolsPanelProps) {
  const webUnavailable = getOpenWorkDeployment() === "web";

  if (props.section === "scheduled") {
    return (
      <WebUnavailableSurface unavailable={webUnavailable}>
        <ScheduledTasksView {...props.scheduled} />
      </WebUnavailableSurface>
    );
  }

  if (props.section === "skills") {
    return (
      <WebUnavailableSurface unavailable={webUnavailable}>
        <SkillsView {...props.skills} />
      </WebUnavailableSurface>
    );
  }

  if (props.section === "extensions") {
    return (
      <WebUnavailableSurface unavailable={webUnavailable}>
        <ExtensionsView {...props.extensions} />
      </WebUnavailableSurface>
    );
  }

  return (
    <WebUnavailableSurface unavailable={webUnavailable}>
      <IdentitiesView {...props.identities} />
    </WebUnavailableSurface>
  );
}
