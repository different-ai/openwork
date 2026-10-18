/** @jsxImportSource react */
import { useState } from "react";
import { CheckCircle2, Download, LoaderCircle, Trash2, XCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { formatFileSize } from "@/lib/utils";
import { useOrgRestrictions } from "../cloud/desktop-config-provider";
import { DictationError, encodeWav, transcribeRecording } from "../session/surface/composer/dictation-audio";
import {
  useBuiltinModelActions,
  useBuiltinModelId,
  useBuiltinModels,
  useBuiltinModelStatus,
  type DictationModelInfo,
} from "../session/surface/composer/dictation-builtin";
import { DICTATION_DEFAULT_ENDPOINT, useDictationStore, type DictationEngine } from "../session/surface/composer/dictation-store";
import { setDictationExtensionEnabled, useDictationExtensionEnabled } from "../session/surface/composer/use-dictation";
import { surfaceCardClass } from "../workspace/modal-styles";
import { registerExtensionConfig } from "./extension-registry";

const voiceDictationConfigFactory = () => <VoiceDictationConfig />;

registerExtensionConfig("openwork.dictation.settings", voiceDictationConfigFactory);
registerExtensionConfig("voice-dictation", voiceDictationConfigFactory);

/** Settings › Voice dictation: the on/off switch for the composer mic, then which speech engine it uses. */
export function VoiceDictationSettings() {
  const enabled = useDictationExtensionEnabled();
  const blocked = useOrgRestrictions().allowBuiltInExtensions === false;
  return (
    <div className="space-y-4">
      <div className={`${surfaceCardClass} flex items-center justify-between gap-4 p-4`}>
        <div className="space-y-1">
          <label htmlFor="dictation-enabled" className="text-[14px] font-medium text-dls-text">Microphone in the composer</label>
          <p className="text-[13px] text-dls-secondary">
            {blocked
              ? t("extensions.disabled_by_organization")
              : "Click the mic, speak, and click again. Your words go into the prompt as text you can edit."}
          </p>
        </div>
        <Switch
          id="dictation-enabled"
          checked={enabled && !blocked}
          disabled={blocked}
          onCheckedChange={(checked) => setDictationExtensionEnabled(checked)}
        />
      </div>
      <VoiceDictationConfig />
    </div>
  );
}

function VoiceDictationConfig() {
  const engine = useDictationStore((state) => state.engine);
  const updateSettings = useDictationStore((state) => state.updateSettings);
  return (
    <div className={`${surfaceCardClass} space-y-4 p-4`}>
      <RadioGroup
        className="w-full gap-2"
        value={engine}
        onValueChange={(value: DictationEngine) => updateSettings({ engine: value })}
      >
        <FieldLabel htmlFor="dictation-engine-builtin">
          <Field orientation="horizontal">
            <RadioGroupItem value="builtin" id="dictation-engine-builtin" />
            <FieldContent>
              <FieldTitle>Built into OpenWork</FieldTitle>
              <FieldDescription>Downloads a speech model once, then works offline. Your voice never leaves this computer.</FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="dictation-engine-server">
          <Field orientation="horizontal">
            <RadioGroupItem value="server" id="dictation-engine-server" />
            <FieldContent>
              <FieldTitle>Your own transcription server</FieldTitle>
              <FieldDescription>Use a server you run, such as whisper.cpp or a Parakeet server.</FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
      </RadioGroup>
      {engine === "builtin" ? <BuiltinModels /> : <ServerSettings />}
    </div>
  );
}

function BuiltinModels() {
  const models = useBuiltinModels();
  const activeModelId = useBuiltinModelId();
  const updateSettings = useDictationStore((state) => state.updateSettings);
  if (!models.data) return null;
  if (models.data.length === 1) return <BuiltinModelRow model={models.data[0]} />;
  return (
    <RadioGroup
      className="w-full gap-2"
      value={activeModelId}
      onValueChange={(value: string) => updateSettings({ desktopModel: value })}
    >
      {models.data.map((model) => <BuiltinModelRow key={model.id} model={model} selectable />)}
    </RadioGroup>
  );
}

function BuiltinModelRow(props: { model: DictationModelInfo; selectable?: boolean }) {
  const status = useBuiltinModelStatus(props.model.id);
  const actions = useBuiltinModelActions(props.model.id);
  const data = status.data;
  const percent = data?.state === "downloading" && data.totalBytes > 0 ? Math.min(99, Math.round((data.receivedBytes / data.totalBytes) * 100)) : 0;
  const content = (
    <Field orientation="horizontal">
      {props.selectable ? <RadioGroupItem value={props.model.id} id={`dictation-model-${props.model.id}`} /> : null}
      <FieldContent>
        <FieldTitle>{props.model.label}</FieldTitle>
        <FieldDescription>
          {props.model.description} {data?.state === "ready" ? "Downloaded." : `${formatFileSize(props.model.downloadBytes)} download.`}
        </FieldDescription>
        {data?.state === "downloading" ? <Progress value={percent} className="mt-1" /> : null}
        {data?.state === "failed" ? <p className="text-[13px] text-dls-secondary">Couldn't download it: {data.error}</p> : null}
      </FieldContent>
      {data?.state === "ready" ? (
        <Button variant="ghost" size="sm" onClick={() => void actions.remove()}>
          <Trash2 />
          Remove
        </Button>
      ) : data?.state === "downloading" ? (
        <span className="shrink-0 text-[13px] tabular-nums text-dls-secondary">{percent}%</span>
      ) : (
        <Button variant="outline" size="sm" onClick={() => void actions.download()}>
          <Download />
          {data?.state === "failed" ? "Try again" : "Download"}
        </Button>
      )}
    </Field>
  );
  return props.selectable ? <FieldLabel htmlFor={`dictation-model-${props.model.id}`}>{content}</FieldLabel> : content;
}

type CheckState = { kind: "idle" } | { kind: "checking" } | { kind: "ok" } | { kind: "failed"; message: string };

function ServerSettings() {
  const endpoint = useDictationStore((state) => state.endpoint);
  const model = useDictationStore((state) => state.model);
  const language = useDictationStore((state) => state.language);
  const updateSettings = useDictationStore((state) => state.updateSettings);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  const checkServer = async () => {
    setCheck({ kind: "checking" });
    try {
      // Half a second of silence: enough to prove the server accepts audio and answers.
      await transcribeRecording(encodeWav(new Float32Array(8_000), 16_000), { endpoint, model, language });
      setCheck({ kind: "ok" });
    } catch (error) {
      setCheck({ kind: "failed", message: error instanceof DictationError ? error.message : "The transcription server didn't answer." });
    }
  };

  return (
    <div className="space-y-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="dictation-endpoint">Transcription server</FieldLabel>
          <Input
            id="dictation-endpoint"
            value={endpoint}
            placeholder={DICTATION_DEFAULT_ENDPOINT}
            onChange={(event) => {
              updateSettings({ endpoint: event.currentTarget.value });
              setCheck({ kind: "idle" });
            }}
          />
          <FieldDescription>
            Any OpenAI-compatible transcription endpoint. With whisper.cpp, run{" "}
            <code>whisper-server -m ggml-base.en.bin --port 8080 --inference-path /v1/audio/transcriptions</code>.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="dictation-model">Model</FieldLabel>
          <Input
            id="dictation-model"
            value={model}
            onChange={(event) => updateSettings({ model: event.currentTarget.value })}
          />
          <FieldDescription>whisper.cpp ignores this. Servers that host several models, such as Parakeet or faster-whisper servers, need the model name.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="dictation-language">Language</FieldLabel>
          <Input
            id="dictation-language"
            value={language}
            placeholder="Detect automatically"
            onChange={(event) => updateSettings({ language: event.currentTarget.value })}
          />
          <FieldDescription>Optional two-letter code, such as en or fr.</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void checkServer()} disabled={check.kind === "checking" || !endpoint.trim()}>
          {check.kind === "checking" ? <LoaderCircle className="animate-spin" /> : null}
          Check server
        </Button>
        {check.kind === "ok" ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-dls-secondary">
            <CheckCircle2 className="size-4 text-green-11" />
            Server is answering
          </span>
        ) : null}
      </div>
      {check.kind === "failed" ? (
        <Alert>
          <XCircle />
          <AlertDescription>{check.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
