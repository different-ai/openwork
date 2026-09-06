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
import { LMSTUDIO_PROVIDER_CONFIG } from "./openai-image-extension";
import { registerExtensionConfig, type ExtensionConfigContext } from "./extension-registry";

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

/** A model entry surfaced by the LM Studio local server. */
type LMStudioModel = {
  id: string;
  /** "llm" | "vlm" | "embeddings" from the native /api/v0/models endpoint. */
  type?: string;
  state?: string;
  maxContextLength?: number;
};

type LMStudioStatus = "checking" | "running" | "unreachable";

/** Base URL for the LM Studio server without the trailing OpenAI "/v1" segment. */
const LMSTUDIO_BASE = LMSTUDIO_PROVIDER_CONFIG.baseURL.replace(/\/v1\/?$/, "");

/**
 * Fetch the models currently available in the running LM Studio instance.
 *
 * Prefers the native REST endpoint (`/api/v0/models`) which reports the model
 * type and load state, and falls back to the OpenAI-compatible `/v1/models`
 * endpoint on older LM Studio builds. The previous behaviour relied on the
 * static models.dev catalog, which only ever listed three hardcoded models
 * regardless of what the user had downloaded (#bug: hardcoded LM Studio models).
 */
async function fetchLMStudioModels(): Promise<{ status: "running" | "unreachable"; models: LMStudioModel[] }> {
  // Native endpoint first — richer metadata (type, loaded state, context length).
  try {
    const response = await fetch(`${LMSTUDIO_BASE}/api/v0/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json();
      const models = (Array.isArray(data?.data) ? data.data : [])
        .map((entry: Record<string, unknown>): LMStudioModel => ({
          id: String(entry.id ?? ""),
          type: typeof entry.type === "string" ? entry.type : undefined,
          state: typeof entry.state === "string" ? entry.state : undefined,
          maxContextLength:
            typeof entry.max_context_length === "number" ? entry.max_context_length : undefined,
        }))
        .filter((model: LMStudioModel) => model.id && model.type !== "embeddings");
      return { status: "running", models };
    }
  } catch {
    // Fall through to the OpenAI-compatible endpoint below.
  }

  // OpenAI-compatible fallback.
  try {
    const response = await fetch(`${LMSTUDIO_PROVIDER_CONFIG.baseURL}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { status: "unreachable", models: [] };
    }
    const data = await response.json();
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((entry: Record<string, unknown>): LMStudioModel => ({ id: String(entry.id ?? "") }))
      .filter((model: LMStudioModel) => model.id);
    return { status: "running", models };
  } catch {
    return { status: "unreachable", models: [] };
  }
}

function useLMStudioModels() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["lmstudio", "models"],
    queryFn: fetchLMStudioModels,
    refetchOnWindowFocus: false,
  });

  const status: LMStudioStatus = isFetching ? "checking" : (data?.status ?? "unreachable");

  return { data, isFetching, refetch, status };
}

export type LMStudioConfigProps = {
  busy: boolean;
  status: string | null;
  error: string | null;
  onInstall: (input: {
    providerId: string;
    name: string;
    baseURL: string;
    modelId: string;
    modelName: string;
    setDefault: boolean;
  }) => void | Promise<void>;
};

export function LMStudioConfig(props: LMStudioConfigProps) {
  const [selectedModel, setSelectedModel] = useState("");
  const [setDefault, setSetDefault] = useState(true);

  const { data, isFetching, refetch, status } = useLMStudioModels();

  const models = data?.models ?? [];

  useEffect(() => {
    if (!selectedModel && models[0]) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);

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
              <EmptyTitle>LM Studio isn't running</EmptyTitle>
              <EmptyDescription>
                Start LM Studio and enable its local server (Developer tab) so OpenWork can list your
                downloaded models from {LMSTUDIO_BASE}.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                render={
                  <a href="https://lmstudio.ai/download" target="_blank" rel="noopener noreferrer" />
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

        {/* Model selection */}
        {status === "running" && models.length > 0 ? (
          <FieldSet className="gap-3">
            <FieldLegend variant="label">Available models</FieldLegend>
            <FieldDescription>Select from models available in LM Studio.</FieldDescription>
            <ModelList value={selectedModel} onValueChange={setSelectedModel}>
              {models.map((model) => (
                <ModelListItem key={model.id} model={model} />
              ))}
            </ModelList>
          </FieldSet>
        ) : null}

        {/* No models */}
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
