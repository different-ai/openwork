/** @jsxImportSource react */
import { useState } from "react";
import { CheckCircle2, Image, Loader2, PlusIcon, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type {
  ExtensionConfigContext,
  ExtensionConfigFactory,
  SettingsExtensionDescriptor,
  SettingsExtensionReadyBinding,
  SettingsExtensionRegistration,
} from "./extension-registry";

export type OpenAiImageGenConfigProps = {
  busy: boolean;
  status: string | null;
  error: string | null;
  envKeyDetected: boolean;
  onInstall: (apiKey: string) => void | Promise<void>;
  onTestGenerate: (input: { apiKey: string; prompt: string }) => void | Promise<void>;
};

export const openAiImageGenConfigFactory: ExtensionConfigFactory = (ctx: ExtensionConfigContext) => (
  <OpenAiImageGenConfig
    busy={ctx.imageExtension.busy}
    status={ctx.imageExtension.status}
    error={ctx.imageExtension.error}
    envKeyDetected={ctx.imageExtension.envKeyDetected}
    onInstall={ctx.imageExtension.onInstall}
    onTestGenerate={ctx.imageExtension.onTestGenerate}
  />
);

export const openAiImageGenSettingsDescriptor = {
  id: "openai-image-gen",
  kind: "app.settings-extension",
  contractVersion: 1,
  provenance: { packageName: "@openwork/app", source: "builtin" },
  order: 100,
  settingsPanelRefs: ["openwork.imageGen.settings", "openai-image-gen"],
  connectionRefs: [],
} as const satisfies SettingsExtensionDescriptor;

export const openAiImageGenSettingsBinding = {
  status: "ready",
  create: () => ({ settingsPanel: openAiImageGenConfigFactory }),
} as const satisfies SettingsExtensionReadyBinding;

export const openAiImageGenSettingsContribution = {
  descriptor: openAiImageGenSettingsDescriptor,
  binding: openAiImageGenSettingsBinding,
} as const satisfies SettingsExtensionRegistration;

const DEFAULT_PROMPT =
  "A friendly robot owl holding a paintbrush, teal neon UI frame, high contrast";

export function OpenAiImageGenConfig(props: OpenAiImageGenConfigProps) {
  const [apiKey, setApiKey] = useState("");
  const canSubmit = Boolean(apiKey.trim());

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>Connect OpenAI image generation with an OpenAI API key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.envKeyDetected ? (
          <Alert variant="warning">
            <Image />
            <AlertTitle>API key found in environment</AlertTitle>
            <AlertDescription>
              An existing OPENAI_API_KEY was detected. The key you save here will take precedence.
            </AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="openai-image-api-key">OpenAI API key</FieldLabel>
            <Input
              id="openai-image-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="sk-..."
            />
            {props.envKeyDetected ? (
              <FieldDescription>
                Overrides the OPENAI_API_KEY environment variable if set.
              </FieldDescription>
            ) : null}
          </Field>
        </FieldGroup>

        {props.status ? (
          <Alert>
            <CheckCircle2 />
            <AlertDescription>{props.status}</AlertDescription>
          </Alert>
        ) : null}
        {props.error ? (
          <Alert variant="destructive">
            <XCircle />
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2 border-t border-border justify-between">
        <Button
          onClick={() => void props.onInstall(apiKey)}
          disabled={props.busy || !canSubmit}
        >
          {props.busy && <Loader2 className="size-4 animate-spin" />}
          Enable
        </Button>
        <Button
          variant="outline"
          onClick={() => void props.onTestGenerate({ apiKey, prompt: DEFAULT_PROMPT })}
          disabled={props.busy || !canSubmit}
        >
          Generate test image
        </Button>
      </CardFooter>
    </Card>
  );
}
