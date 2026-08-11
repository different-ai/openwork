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
import { t } from "@/i18n";
import { registerExtensionConfig, type ExtensionConfigContext } from "./extension-registry";

export type OpenAiImageGenConfigProps = {
  busy: boolean;
  status: string | null;
  error: string | null;
  envKeyDetected: boolean;
  onInstall: (apiKey: string) => void | Promise<void>;
  onTestGenerate: (input: { apiKey: string; prompt: string }) => void | Promise<void>;
};

const openAiImageGenConfigFactory = (ctx: ExtensionConfigContext) => (
  <OpenAiImageGenConfig
    busy={ctx.imageExtension.busy}
    status={ctx.imageExtension.status}
    error={ctx.imageExtension.error}
    envKeyDetected={ctx.imageExtension.envKeyDetected}
    onInstall={ctx.imageExtension.onInstall}
    onTestGenerate={ctx.imageExtension.onTestGenerate}
  />
);

registerExtensionConfig("openwork.imageGen.settings", openAiImageGenConfigFactory);
registerExtensionConfig("openai-image-gen", openAiImageGenConfigFactory);

const DEFAULT_PROMPT =
  "A friendly robot owl holding a paintbrush, teal neon UI frame, high contrast";

export function OpenAiImageGenConfig(props: OpenAiImageGenConfigProps) {
  const [apiKey, setApiKey] = useState("");
  const canSubmit = Boolean(apiKey.trim());

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>{t("imagegen.config_title")}</CardTitle>
        <CardDescription>{t("imagegen.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.envKeyDetected ? (
          <Alert variant="warning">
            <Image />
            <AlertTitle>{t("imagegen.env_key_found")}</AlertTitle>
            <AlertDescription>
              {t("imagegen.env_key_found_desc")}
            </AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="openai-image-api-key">{t("imagegen.api_key_label")}</FieldLabel>
            <Input
              id="openai-image-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="sk-..."
            />
            {props.envKeyDetected ? (
              <FieldDescription>
                {t("imagegen.overrides_env")}
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
          {t("imagegen.enable")}
        </Button>
        <Button
          variant="outline"
          onClick={() => void props.onTestGenerate({ apiKey, prompt: DEFAULT_PROMPT })}
          disabled={props.busy || !canSubmit}
        >
          {t("imagegen.generate_test_image")}
        </Button>
      </CardFooter>
    </Card>
  );
}
