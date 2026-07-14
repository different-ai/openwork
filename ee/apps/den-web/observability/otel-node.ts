import { context } from "@opentelemetry/api";
import type { Attributes, AttributeValue, Link } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, Sampler, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type {
  OTelBackendObservabilityConfig,
  OTelSamplerConfig,
  OTelSignalConfig,
  JsonObject,
  StructuredLogLevel,
} from "@openwork-ee/utils/observability";

import {
  isTelemetrySdkStarted,
  registerRetainedTelemetryShutdownHandlers,
  retainTelemetrySdk,
  setStructuredLogSink,
} from "./runtime-logger";
import type { TelemetrySignalTarget } from "./runtime-logger";
import { scrubLogFields, scrubText, shouldRedactTelemetryKey } from "./scrub";

function exporterOptions(signal: OTelSignalConfig): { url: string } | undefined {
  return signal.endpoint === undefined ? undefined : { url: signal.endpoint };
}

function nodeSignalTarget(): TelemetrySignalTarget {
  return {
    on: (signal, listener) => process.on(signal, listener),
  };
}

function isStringArray(value: AttributeValue): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function scrubOtelAttributeValue(key: string, value: AttributeValue | undefined): AttributeValue | undefined {
  if (value === undefined) return undefined;
  if (shouldRedactTelemetryKey(key)) return "[redacted]";
  if (typeof value === "string") return scrubText(value);
  if (isStringArray(value)) {
    return value.map((item) => typeof item === "string" ? scrubText(item) : item);
  }
  return value;
}

function scrubOtelAttributes(attributes: Attributes | undefined): Attributes | undefined {
  if (attributes === undefined) return undefined;

  const scrubbed: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    scrubbed[key] = scrubOtelAttributeValue(key, value);
  }
  return scrubbed;
}

function scrubOtelEvent(event: TimedEvent): TimedEvent {
  return {
    ...event,
    name: scrubText(event.name),
    attributes: scrubOtelAttributes(event.attributes),
  };
}

function scrubOtelLink(link: Link): Link {
  return {
    ...link,
    attributes: scrubOtelAttributes(link.attributes),
  };
}

export function scrubOtelSpan(span: ReadableSpan): ReadableSpan {
  const name = scrubText(span.name);
  const status = span.status.message === undefined
    ? span.status
    : { ...span.status, message: scrubText(span.status.message) };
  const attributes = scrubOtelAttributes(span.attributes) ?? {};
  const events = span.events.map(scrubOtelEvent);
  const links = span.links.map(scrubOtelLink);

  return new Proxy(span, {
    get(target, property, receiver) {
      switch (property) {
        case "name":
          return name;
        case "status":
          return status;
        case "attributes":
          return attributes;
        case "events":
          return events;
        case "links":
          return links;
        default:
          return Reflect.get(target, property, receiver);
      }
    },
  });
}

class SanitizingSpanExporter implements SpanExporter {
  private readonly exporter: SpanExporter;

  constructor(exporter: SpanExporter) {
    this.exporter = exporter;
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.exporter.export(spans.map(scrubOtelSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush === undefined ? Promise.resolve() : this.exporter.forceFlush();
  }
}

function buildRootSampler(sampler: OTelSamplerConfig): Sampler {
  switch (sampler.name) {
    case "always_on":
    case "parentbased_always_on":
      return new AlwaysOnSampler();
    case "always_off":
    case "parentbased_always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
    case "parentbased_traceidratio":
      return new TraceIdRatioBasedSampler(sampler.ratio);
  }
}

function buildSampler(sampler: OTelSamplerConfig): Sampler {
  const root = buildRootSampler(sampler);
  if (sampler.name.startsWith("parentbased_")) {
    return new ParentBasedSampler({ root });
  }
  return root;
}

function severityNumber(level: StructuredLogLevel): SeverityNumber {
  switch (level) {
    case "debug":
      return SeverityNumber.DEBUG;
    case "info":
      return SeverityNumber.INFO;
    case "warn":
      return SeverityNumber.WARN;
    case "error":
      return SeverityNumber.ERROR;
  }
}

function severityText(level: StructuredLogLevel): string {
  return level.toUpperCase();
}

function scrubOtelLogAttributes(fields: JsonObject | undefined): Attributes | undefined {
  const scrubbed = scrubLogFields(fields);
  if (scrubbed === undefined) return undefined;

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(scrubbed)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[key] = value;
      continue;
    }

    const serialized = JSON.stringify(value);
    attributes[key] = serialized === undefined ? "" : serialized;
  }
  return attributes;
}

function configureOtelLogSink(serviceName: string): void {
  const logger = logs.getLogger(serviceName);
  setStructuredLogSink({
    log: (level, message, fields) => {
      logger.emit({
        context: context.active(),
        severityNumber: severityNumber(level),
        severityText: severityText(level),
        body: scrubText(message),
        attributes: scrubOtelLogAttributes(fields),
      });
    },
  });
}

export function startOtel(config: OTelBackendObservabilityConfig): void {
  if (isTelemetrySdkStarted()) return;

  const sdkConfig: Partial<NodeSDKConfiguration> = {
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
    sampler: buildSampler(config.otel.sampler),
  };

  if (config.otel.signals.traces.exporter === "otlp") {
    sdkConfig.traceExporter = new SanitizingSpanExporter(
      new OTLPTraceExporter(exporterOptions(config.otel.signals.traces)),
    );
  } else {
    sdkConfig.spanProcessors = [];
  }

  if (config.otel.signals.metrics.exporter === "otlp") {
    sdkConfig.metricReaders = [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(exporterOptions(config.otel.signals.metrics)),
      }),
    ];
  } else {
    sdkConfig.metricReaders = [];
  }

  if (config.otel.signals.logs.exporter === "otlp") {
    sdkConfig.logRecordProcessors = [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter(exporterOptions(config.otel.signals.logs)),
      }),
    ];
  } else {
    sdkConfig.logRecordProcessors = [];
  }

  const sdk = new NodeSDK(sdkConfig);
  sdk.start();
  retainTelemetrySdk(sdk);
  registerRetainedTelemetryShutdownHandlers(nodeSignalTarget());
  configureOtelLogSink(config.serviceName);
}
