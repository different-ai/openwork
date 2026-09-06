/** @jsxImportSource react */
import * as React from "react";
import { desktopPolicyDefinitions } from "@openwork/types/den/desktop-policies";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrgRestrictions } from "../../cloud/desktop-config-provider";
import {
  SettingsList,
  SettingsListItem,
  SettingsListItemContent,
  SettingsListItemTitle,
} from "../settings-list";
import { t } from "@/i18n";
import { SignInFallbackNotice } from "@/react-app/domains/cloud/signin-fallback-notice";
import { CloudAccountSection } from "../cloud/cloud-account-section";
import { useCloudSession } from "../cloud/cloud-session-provider";
import { CloudDevMode } from "../cloud/dev-mode";
import type { useDenSession } from "../cloud/use-den-session";
import {
  SettingsInset,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
  SettingsStack,
  SettingsStatusBadge,
} from "../settings-section";

type CloudAccountSession = Pick<
  ReturnType<typeof useDenSession>,
  | "authBusy"
  | "authError"
  | "baseUrlBusy"
  | "baseUrlDraft"
  | "baseUrlError"
  | "needsOrgSelection"
  | "orgs"
  | "orgsBusy"
  | "orgsError"
  | "sessionBusy"
  | "signinFallbackUrl"
  | "summaryLabel"
  | "summaryTone"
  | "onActiveOrgChange"
  | "onApplyBaseUrl"
  | "onBaseUrlDraftChange"
  | "onClearAuthError"
  | "onOpenBrowserAuth"
  | "onOpenControlPlane"
  | "onRefreshOrgs"
  | "onResetBaseUrl"
  | "onSignOut"
  | "onSubmitManualAuth"
>;

export type CloudAccountViewProps = {
  developerMode: boolean;
  session: CloudAccountSession;
};

type DenSignedOutPanelProps = Pick<
  CloudAccountSession,
  | "authBusy"
  | "authError"
  | "onClearAuthError"
  | "onOpenBrowserAuth"
  | "onSubmitManualAuth"
  | "sessionBusy"
  | "signinFallbackUrl"
>;

function DenSignedOutPanel({
  authBusy,
  authError,
  onClearAuthError,
  onOpenBrowserAuth,
  onSubmitManualAuth,
  sessionBusy,
  signinFallbackUrl,
}: DenSignedOutPanelProps) {
  const [manualAuthOpen, setManualAuthOpen] = React.useState(false);
  const [manualAuthInput, setManualAuthInput] = React.useState("");
  const controlsDisabled = [authBusy, sessionBusy].some(Boolean);

  React.useEffect(() => {
    if (signinFallbackUrl) setManualAuthOpen(true);
  }, [signinFallbackUrl]);

  const submitManualAuth = async () => {
    const ok = await onSubmitManualAuth(manualAuthInput);
    if (!ok) return;
    setManualAuthInput("");
    setManualAuthOpen(false);
  };

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>{t("den.signin_title")}</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription className="max-w-[54ch]">
            {t("den.cloud_sleep_hint")}
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
      </SettingsSectionHeader>

      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onOpenBrowserAuth("sign-in")}>
            {t("den.signin_button")}
            <ArrowUpRight size={13} />
          </Button>
          <Button variant="outline" onClick={() => onOpenBrowserAuth("sign-up")}>
            {t("den.create_account")}
            <ArrowUpRight size={13} />
          </Button>
        </div>

        {signinFallbackUrl ? <SignInFallbackNotice url={signinFallbackUrl} /> : null}

        <Collapsible
          open={manualAuthOpen}
          onOpenChange={(open) => {
            setManualAuthOpen(open);
            onClearAuthError();
          }}
          disabled={controlsDisabled}
          className="flex flex-col gap-3"
        >
          <CollapsibleTrigger
            render={<Button variant="ghost" size="sm" className="w-fit self-start" disabled={controlsDisabled} />}
          >
            {manualAuthOpen ? t("den.hide_signin_code") : t("den.paste_signin_code")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SettingsInset className="flex flex-col gap-y-3">
              <Field data-disabled={controlsDisabled}>
                <FieldLabel htmlFor="den-signin-link">{t("den.signin_link_label")}</FieldLabel>
                <Input
                  id="den-signin-link"
                  value={manualAuthInput}
                  onChange={(event) => setManualAuthInput(event.currentTarget.value)}
                  placeholder={t("den.signin_link_placeholder")}
                  disabled={controlsDisabled}
                />
                <FieldDescription className="text-xs">{t("den.signin_link_hint")}</FieldDescription>
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void submitManualAuth()}
                  disabled={[controlsDisabled, !manualAuthInput.trim()].some(Boolean)}
                >
                  {authBusy ? t("den.finishing") : t("den.finish_signin")}
                </Button>
              </div>
            </SettingsInset>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {authError ? <SettingsNotice tone="error">{authError}</SettingsNotice> : null}

      <SettingsInset className="text-sm text-gray-10">
        {t("den.auto_reconnect_hint")}
      </SettingsInset>
    </SettingsSection>
  );
}

const permissionLabels = {
  allowCustomProviders: "Add AI providers",
  allowZenModel: "Use OpenCode models",
  allowMultipleWorkspaces: "Create more workspaces",
  allowControlSettings: "Change app settings",
  allowManageExtensions: "Add tools, skills & MCP servers",
  allowBuiltInExtensions: "Use built-in extensions",
  allowBrowserLoginSync: "Keep browser logins synced",
  allowAlphaUpdates: "Try experimental updates",
  showWelcomePage: "Show welcome page",
};

function AppPermissionsView() {
  const config = useOrgRestrictions();
  return (
    <SettingsStack>
      <Separator />
      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>Your app permissions</SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              These are your current permissions for this organization.
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>
        <SettingsList>
          {desktopPolicyDefinitions.filter((entry) => entry.restrictedValue !== null).map((entry) => {
            const allowed = config[entry.id] !== false;
            return (
              <div key={entry.id} data-testid={`app-permission-${entry.id}`}>
                <SettingsListItem>
                  <SettingsListItemContent>
                    <SettingsListItemTitle>{permissionLabels[entry.id]}</SettingsListItemTitle>
                  </SettingsListItemContent>
                  <SettingsStatusBadge label={allowed ? "Allowed" : "Blocked"} tone={allowed ? "ready" : "neutral"} />
                </SettingsListItem>
              </div>
            );
          })}
        </SettingsList>
        {config.execution && (config.execution.commands === "deny" || config.execution.blockedCommands.length > 0 || config.execution.browserOrigins !== undefined || config.execution.blockBrowserUploads) ? (
          <SettingsList>
            <SettingsListItem>
              <SettingsListItemContent>
                <SettingsListItemTitle>OS commands</SettingsListItemTitle>
              </SettingsListItemContent>
              <SettingsStatusBadge label={config.execution.commands === "deny" ? "Blocked" : config.execution.blockedCommands.length ? "Some commands restricted" : "Allowed"} tone="neutral" />
            </SettingsListItem>
            {config.execution.browserOrigins !== undefined ? <SettingsListItem>
              <SettingsListItemContent>
                <SettingsListItemTitle>Approved websites</SettingsListItemTitle>
                <SettingsSectionHeaderDescription>{config.execution.browserOrigins.length ? config.execution.browserOrigins.join(", ") : "Browsing is blocked."}</SettingsSectionHeaderDescription>
              </SettingsListItemContent>
            </SettingsListItem> : null}
            {config.execution.blockBrowserUploads ? <SettingsListItem>
              <SettingsListItemContent><SettingsListItemTitle>Browser uploads and form submissions</SettingsListItemTitle></SettingsListItemContent>
              <SettingsStatusBadge label="Blocked" tone="neutral" />
            </SettingsListItem> : null}
          </SettingsList>
        ) : null}
        <SettingsSectionHeaderDescription>
          Your administrator manages team permissions in Cloud → Team → Access.
          Ask them if you need a change, including access to an MCP server or skill.
        </SettingsSectionHeaderDescription>
      </SettingsSection>
    </SettingsStack>
  );
}

export function CloudAccountView({ developerMode, session }: CloudAccountViewProps) {
  const { activeOrganization, isSignedIn, statusMessage } = useCloudSession();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (!isSignedIn || !session.needsOrgSelection) return;
    navigate("/onboarding", { replace: true });
  }, [isSignedIn, navigate, session.needsOrgSelection]);

  const accountContent = (
    <SettingsStack>
      <Separator />

      <SettingsSection>
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>
              {t("den.cloud_section_title")}
              <SettingsStatusBadge tone={session.summaryTone} label={session.summaryLabel} />
            </SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              {t(isSignedIn ? "den.cloud_signed_in_desc" : "den.cloud_section_desc")}
            </SettingsSectionHeaderDescription>
            {!isSignedIn ? (
              <SettingsSectionHeaderDescription className="text-xs">
                {t("den.cloud_sleep_hint")}
              </SettingsSectionHeaderDescription>
            ) : null}
          </SettingsSectionHeaderContent>
        </SettingsSectionHeader>

        {developerMode ? (
          <CloudDevMode
            authBusy={session.authBusy}
            baseUrlBusy={session.baseUrlBusy}
            baseUrlDraft={session.baseUrlDraft}
            onApplyBaseUrl={session.onApplyBaseUrl}
            onBaseUrlDraftChange={session.onBaseUrlDraftChange}
            onOpenControlPlane={session.onOpenControlPlane}
            onResetBaseUrl={session.onResetBaseUrl}
            sessionBusy={session.sessionBusy}
          />
        ) : null}

        {session.baseUrlError ? <SettingsNotice tone="error">{session.baseUrlError}</SettingsNotice> : null}

        {isSignedIn && session.authError ? (
          <SettingsNotice tone="error">{session.authError}</SettingsNotice>
        ) : null}

        {statusMessage && !session.authError && !session.orgsError ? (
          <SettingsNotice>{statusMessage}</SettingsNotice>
        ) : null}

        {isSignedIn ? (
          <CloudAccountSection
            activeOrgId={activeOrganization?.id ?? ""}
            authBusy={session.authBusy}
            needsOrgSelection={session.needsOrgSelection}
            orgs={session.orgs}
            orgsBusy={session.orgsBusy}
            orgsError={session.orgsError}
            sessionBusy={session.sessionBusy}
            onActiveOrgChange={session.onActiveOrgChange}
            onOpenDashboard={session.onOpenControlPlane}
            onRefreshOrgs={session.onRefreshOrgs}
            onSignOut={session.onSignOut}
          />
        ) : null}
      </SettingsSection>

      <Separator />

      {!isSignedIn ? (
        <DenSignedOutPanel
          authBusy={session.authBusy}
          authError={session.authError}
          onClearAuthError={session.onClearAuthError}
          onOpenBrowserAuth={session.onOpenBrowserAuth}
          onSubmitManualAuth={session.onSubmitManualAuth}
          sessionBusy={session.sessionBusy}
          signinFallbackUrl={session.signinFallbackUrl}
        />
      ) : null}
    </SettingsStack>
  );

  if (!isSignedIn) return accountContent;

  return (
    <Tabs defaultValue="account" className="w-full max-w-3xl gap-y-6">
      <TabsList variant="line" aria-label="Account pages">
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger value="permissions">App permissions</TabsTrigger>
      </TabsList>
      <TabsContent value="account">{accountContent}</TabsContent>
      <TabsContent value="permissions"><AppPermissionsView /></TabsContent>
    </Tabs>
  );
}
