/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LMSTUDIO_PROVIDER_CONFIG, type LocalProviderInstallInput } from "./openai-image-extension";
import { registerExtensionConfig, type ExtensionConfigContext } from "./extension-registry";
import {
  fetchLMStudioModels,
  LMSTUDIO_BASE_URL,
  reconcileLMStudioSelectedModel,
  type LMStudioModel,
} from "./lmstudio-models";

const lmstudioConfigFactory = (ctx: ExtensionConfigContext) => (
  <LMStudioConfig
    busy={ctx.localProvider.busy}
    status={ctx.localProvider.status}
    error={ctx.localProvider.error}
    onInstall={ctx.localProvider.onInstall}
  />
);

registerExtensionConfig("openwork.lmstudio.settings", lmstudioConfigFactory);
registerExtensionConfig("lmstudio", lmstudioConfigFactory);

type LMStudioStatus = "checking" | "running" | "unreachable";

function useLMStudioModels() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["lmstudio", "models"],
    queryFn: () => fetchLMStudioModels(),
    refetchOnWindowFocus: false,
  });

  const status: LMStudioStatus = isFetching ? "checking" : (data?.status ?? "unreachable");

  return { data, isFetching, refetch, status };
}

export type LMStudioConfigProps = {
  busy: boolean;
  status: string | null;
  error: string | null;
  onInstall: (input: LocalProviderInstallInput) => void | Promise<void>;
};

export function LMStudioConfig(props: LMStudioConfigProps) {
  const [selectedModel, setSelectedModel] = useState("");
  const [setDefault, setSetDefault] = useState(true);

  const { data, isFetching, refetch, status } = useLMStudioModels();
  const models = data?.models ?? [];

  useEffect(() => {
    setSelectedModel((current) => reconcileLMStudioSelectedModel(current, models));
  }, [models]);

  const handleInstall = () => {
    if (!selectedModel) {
      return;
    }

    void props.onInstall({
      providerId: LMSTUDIO_PROVIDER_CONFIG.providerId,
      name: LMSTUDIO_PROVIDER_CONFIG.name,
      baseURL: LMSTUDIO_PROVIDER_CONFIG.baseURL,
      modelId: selectedModel,
      modelName: selectedModel,
      setDefault,
      allModelIds: models.map((model) => model.id),
    });
  };

  if (status === "unreachable") {
    return (
      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>Connect to a local LM Studio instance and choose a model.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="icon-sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? "animate-spin" : ""} />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {props.error ? (
            <Alert variant="destructive">
              <XCircle />
              <AlertDescription>{props.error}</AlertDescription>
            </Alert>
          ) : null}

          <Empty className="flex-none p-6" variant="ghost">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Download />
              </EmptyMedia>
              <EmptyTitle>LM Studio isn&apos;t running</EmptyTitle>
              <EmptyDescription>
                Start LM Studio and enable its local server (Developer tab) so OpenWork can list your
                downloaded models from {LMSTUDIO_BASE_URL}.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                render={
                  <a href="https://lmstudio.ai/" target="_blank" rel="noopener noreferrer" />
                }
              >
                Download LM Studio
              </Button>
            </EmptyContent>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>Connect to a local LM Studio instance and choose a model.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? "animate-spin" : ""} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.error ? (
          <Alert variant="destructive">
            <XCircle />
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        ) : null}

        <Alert>
          {status === "checking" ? (
            <Loader2 className="animate-spin" />
          ) : status === "running" ? (
            <CheckCircle2 className="text-green-11!" />
          ) : (
            <XCircle />
          )}
          <AlertDescription>
            {status === "checking"
              ? "Checking LM Studio..."
              : status === "running"
                ? `LM Studio running (${models.length} model${models.length === 1 ? "" : "s"})`
                : "LM Studio not reachable"}
          </AlertDescription>
        </Alert>

        {status === "running" && models.length > 0 ? (
          <div className="flex flex-col gap-2">
            <FieldSet className="gap-3">
              <FieldLegend variant="label">Available models</FieldLegend>
              <FieldDescription>Select from models available in LM Studio.</FieldDescription>
              <ModelList value={selectedModel} onValueChange={setSelectedModel}>
                {models.map((model) => (
                  <ModelListItem key={model.id} model={model} />
                ))}
              </ModelList>
            </FieldSet>
          </div>
        ) : null}

        {status === "running" && models.length === 0 ? (
          <Empty className="flex-none p-6" variant="ghost">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Download />
              </EmptyMedia>
              <EmptyTitle>No models available</EmptyTitle>
              <EmptyDescription>
                Download a model in LM Studio, then refresh to add it to your workspace.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {props.status ? (
          <Alert>
            <CheckCircle2 />
            <AlertDescription>{props.status}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="border-t border-border">
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <Checkbox
              id="lmstudio-set-default"
              name="lmstudio-set-default"
              checked={setDefault}
              onCheckedChange={setSetDefault}
              nativeButton
              render={<button type="button" />}
            />
            <FieldLabel htmlFor="lmstudio-set-default">Use as default model in workspace</FieldLabel>
          </Field>
        </FieldGroup>
        <Button
          onClick={handleInstall}
          disabled={props.busy || !selectedModel || status !== "running"}
        >
          {props.busy && <Loader2 className="size-4 animate-spin" />}
          Add to workspace
        </Button>
      </CardFooter>
    </Card>
  );
}

interface ModelListProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}

export function ModelList({ value, onValueChange, children }: ModelListProps) {
  return (
    <RadioGroup className="w-full gap-2" value={value} onValueChange={onValueChange}>
      {children}
    </RadioGroup>
  );
}

interface ModelListItemProps {
  model: LMStudioModel;
}

function ModelListItem({ model }: ModelListItemProps) {
  const detail = model.maxContextLength
    ? `${Math.round(model.maxContextLength / 1024)}K ctx`
    : model.type;

  return (
    <FieldLabel htmlFor={model.id}>
      <Field orientation="horizontal" size="sm">
        <RadioGroupItem value={model.id} id={model.id} />
        <FieldContent className="flex-row justify-between w-full">
          <FieldTitle>{model.id}</FieldTitle>
          {detail ? <FieldDescription>{detail}</FieldDescription> : null}
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}
