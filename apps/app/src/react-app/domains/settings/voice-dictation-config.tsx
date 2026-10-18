/** @jsxImportSource react */
import { useState } from "react";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { useOrgRestrictions } from "../cloud/desktop-config-provider";
import { DictationError, encodeWav, transcribeRecording } from "../session/surface/composer/dictation-audio";
import { DICTATION_DEFAULT_ENDPOINT, useDictationStore } from "../session/surface/composer/dictation-store";
import { setDictationExtensionEnabled, useDictationExtensionEnabled } from "../session/surface/composer/use-dictation";
import { surfaceCardClass } from "../workspace/modal-styles";
import { registerExtensionConfig } from "./extension-registry";

const voiceDictationConfigFactory = () => <VoiceDictationConfig />;

registerExtensionConfig("openwork.dictation.settings", voiceDictationConfigFactory);
registerExtensionConfig("voice-dictation", voiceDictationConfigFactory);

/** Settings › Voice dictation: the on/off switch for the composer mic, then where to send recordings. */
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

type CheckState = { kind: "idle" } | { kind: "checking" } | { kind: "ok" } | { kind: "failed"; message: string };

function VoiceDictationConfig() {
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
    <div className={`${surfaceCardClass} space-y-4 p-4`}>
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
