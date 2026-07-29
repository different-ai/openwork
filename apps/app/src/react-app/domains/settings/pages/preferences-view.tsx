/** @jsxImportSource react */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { t } from "@/i18n";
import {
  DESKTOP_NOTIFICATION_PREFERENCE_VALUES,
  isDesktopNotificationPreference,
  type DesktopNotificationPreference,
} from "@/react-app/kernel/desktop-notification-preferences";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { DesktopIntegrationSection } from "../desktop-integration-section";

export type PreferencesViewProps = {
  busy: boolean;
  showThinking: boolean;
  onToggleShowThinking: () => void;
  autoCompactContext: boolean;
  autoCompactContextBusy: boolean;
  onToggleAutoCompactContext: () => void;
  analyticsEnabled: boolean;
  onToggleAnalytics: () => void;
  desktopNotifications: DesktopNotificationPreference;
  onDesktopNotificationsChange: (value: DesktopNotificationPreference) => void;
  memoryEnabled: boolean;
  onToggleMemory: () => void;
  stationSupported: boolean;
  stationEnabled: boolean;
  stationBusy: boolean;
  stationStatus: string | null;
  onEnableStation: () => void;
  onOpenStation: () => void;
  onDisableStation: () => void;
};

function desktopNotificationPreferenceLabel(value: DesktopNotificationPreference) {
  switch (value) {
    case "important":
      return t("settings.desktop_notifications.important");
    case "all":
      return t("settings.desktop_notifications.all");
    case "off":
      return t("settings.desktop_notifications.off");
  }
}

export function PreferencesView(props: PreferencesViewProps) {
  const desktopNotificationItems = DESKTOP_NOTIFICATION_PREFERENCE_VALUES.map((value) => ({
    value,
    label: desktopNotificationPreferenceLabel(value),
  }));

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>OpenWork Station</LayoutSectionTitle>
          <LayoutSectionDescription>
            A discreet contextual helper that listens through your microphone,
            uses OpenAI Realtime to research useful context, and keeps every
            action under your control.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              {props.stationEnabled ? "Station is enabled" : "Enable Station"}
            </LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {props.stationSupported
                ? props.stationEnabled
                  ? "The vertical island and shortcut are available. Listening starts while a workspace is open."
                  : "Off means off: no Station window, shortcut, microphone capture, or Realtime session."
                : "Station requires the OpenWork desktop app."}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              {props.stationEnabled ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={props.onOpenStation}
                    disabled={props.stationBusy || !props.stationSupported}
                  >
                    Open Station
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={props.onDisableStation}
                    disabled={props.stationBusy || !props.stationSupported}
                  >
                    Disable
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={props.onEnableStation}
                  disabled={props.stationBusy || !props.stationSupported}
                >
                  {props.stationBusy ? "Enabling…" : "Enable Station"}
                </Button>
              )}
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <div
            className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/15 px-3 py-2"
            aria-label="Station processing path"
          >
            <div className="flex min-w-16 items-center justify-center gap-1" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5, 6].map((dot) => (
                <span
                  key={dot}
                  className={`block rounded-full ${
                    dot === 1 || dot === 3 || dot === 5
                      ? "size-1.5"
                      : "size-1"
                  }`}
                  style={{
                    backgroundColor: "#267ce8",
                    opacity: dot === 1 || dot === 3 || dot === 5 ? 0.9 : 0.38,
                    transform: `translateY(${dot % 3 === 0 ? -1 : dot % 3 === 1 ? 1 : 0}px)`,
                  }}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Physical microphone → OpenAI Realtime → review-only context cards
            </p>
          </div>
          {props.stationStatus ? (
            <p className="text-xs text-muted-foreground" role="status">
              {props.stationStatus}
            </p>
          ) : null}
        </LayoutSectionItem>
      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.model_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.model_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        {/* Show reasoning */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.show_model_reasoning")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.show_model_reasoning_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.show_model_reasoning")}
                checked={props.showThinking}
                disabled={props.busy}
                onCheckedChange={props.onToggleShowThinking}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {/* Auto context compaction */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.auto_compact")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.auto_compact_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.auto_compact")}
                checked={props.autoCompactContext}
                disabled={props.busy || props.autoCompactContextBusy}
                onCheckedChange={props.onToggleAutoCompactContext}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.desktop_notifications.title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.desktop_notifications.section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.desktop_notifications.mode")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.desktop_notifications.mode_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="w-44 max-w-full">
                <Select
                  value={props.desktopNotifications}
                  items={desktopNotificationItems}
                  onValueChange={(value) => {
                    if (isDesktopNotificationPreference(value)) {
                      props.onDesktopNotificationsChange(value);
                    }
                  }}
                  disabled={props.busy}
                >
                  <SelectTrigger className="w-full" aria-label={t("settings.desktop_notifications.mode")}>
                    <SelectValue placeholder={t("settings.desktop_notifications.off")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {DESKTOP_NOTIFICATION_PREFERENCE_VALUES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {desktopNotificationPreferenceLabel(value)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <DesktopIntegrationSection />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.privacy_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.privacy_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.analytics_toggle")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.analytics_toggle_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.analytics_toggle")}
                checked={props.analyticsEnabled}
                disabled={props.busy}
                onCheckedChange={props.onToggleAnalytics}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("memory.preferences_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("memory.preferences_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("memory.preferences_toggle")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("memory.preferences_toggle_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("memory.preferences_toggle")}
                checked={props.memoryEnabled}
                disabled={props.busy}
                onCheckedChange={props.onToggleMemory}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}
