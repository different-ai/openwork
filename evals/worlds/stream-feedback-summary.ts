export type StreamFeedbackSample = {
  kind: "text" | "reasoning";
  token: string;
  receivedAt: number;
  domAt: number | null;
  frameAt: number | null;
  terminalAtFrame: boolean | null;
};

export type StreamFeedbackDisclosure = {
  at: number;
  source: "frame" | "mutation" | "arrival" | "intent" | "attribute-history";
  expanded: boolean | null;
  bodyVisible: boolean;
  receivedReasoning: number;
};

/** A final collapsed snapshot cannot erase an earlier automatic expansion. */
export function streamFeedbackStayedCollapsed(trace: StreamFeedbackDisclosure[], overflow: boolean) {
  return !overflow && trace.some(item => item.receivedReasoning > 0 && item.expanded === false)
    && trace.every(item => item.expanded !== true && !item.bodyVisible);
}

/** Nearest-rank percentiles, per delta, not independent turns or device paint. */
export function streamFeedbackDistribution(values: number[]) {
  if (values.length === 0 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("Stream feedback requires non-empty, finite, non-negative samples");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { n: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) };
}

/** Failure-safe projection: incomplete observations remain censored, never silently dropped. */
export function inspectStreamFeedback(samples: StreamFeedbackSample[], observedAt: number) {
  return ["reasoning", "text"].map(kind => {
    const selected = samples.filter(sample => sample.kind === kind);
    const validDom = selected.filter(sample => sample.domAt !== null && Number.isFinite(sample.domAt)
      && sample.domAt >= sample.receivedAt);
    const validFrame = validDom.filter(sample => sample.frameAt !== null && Number.isFinite(sample.frameAt)
      && sample.frameAt >= (sample.domAt ?? Infinity));
    const invalid = selected.filter(sample => !Number.isFinite(sample.receivedAt)
      || (sample.domAt !== null && (!Number.isFinite(sample.domAt) || sample.domAt < sample.receivedAt))
      || (sample.frameAt !== null && (!Number.isFinite(sample.frameAt) || sample.domAt === null || sample.frameAt < sample.domAt || sample.terminalAtFrame === null)));
    const censored = selected.filter(sample => sample.domAt === null || sample.frameAt === null).map(sample => ({
      token: sample.token, missingDom: sample.domAt === null, missingFrame: sample.frameAt === null,
      atLeastMs: Math.max(0, observedAt - sample.receivedAt),
    }));
    return {
      kind, received: selected.length, invalid: invalid.map(sample => sample.token), censored,
      postCompletion: selected.filter(sample => sample.terminalAtFrame === true).map(sample => sample.token),
      distributionScope: censored.length > 0 || invalid.length > 0 ? "observed subset only; incomplete, not a passing distribution" : "all received eligible deltas",
      dom: validDom.length ? streamFeedbackDistribution(validDom.map(sample => (sample.domAt ?? NaN) - sample.receivedAt)) : null,
      frame: validFrame.length ? streamFeedbackDistribution(validFrame.map(sample => (sample.frameAt ?? NaN) - sample.receivedAt)) : null,
    };
  });
}
