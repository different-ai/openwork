export type StationTranscriptCompletion = {
  accepted: boolean;
  transcript: string;
};

export class StationTranscriptAccumulator {
  readonly #partialByItem = new Map<string, string>();
  readonly #completedByItem = new Map<string, string>();
  readonly #sequenceByItem = new Map<string, number>();
  readonly #limit: number;
  #nextSequence = 0;
  #baseTranscript = "";

  constructor(limit = 12_000) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  reset(baseTranscript = "") {
    this.#partialByItem.clear();
    this.#completedByItem.clear();
    this.#sequenceByItem.clear();
    this.#nextSequence = 0;
    this.#baseTranscript = baseTranscript.trim().slice(-this.#limit);
  }

  markItem(itemId: string) {
    if (!this.#sequenceByItem.has(itemId)) {
      this.#sequenceByItem.set(itemId, this.#nextSequence);
      this.#nextSequence += 1;
    }
  }

  appendDelta(itemId: string, delta: string): string {
    this.markItem(itemId);
    const partial = `${this.#partialByItem.get(itemId) ?? ""}${delta}`;
    this.#partialByItem.set(itemId, partial);
    return partial;
  }

  partial(itemId: string): string {
    return this.#partialByItem.get(itemId) ?? "";
  }

  complete(itemId: string, value: string): StationTranscriptCompletion {
    const transcript = value.trim();
    this.markItem(itemId);
    this.#partialByItem.delete(itemId);
    if (!transcript || this.#completedByItem.get(itemId) === transcript) {
      return { accepted: false, transcript: this.combined() };
    }
    this.#completedByItem.set(itemId, transcript);
    return { accepted: true, transcript: this.combined() };
  }

  combined(): string {
    const live = Array.from(this.#completedByItem.entries())
      .sort(([left], [right]) => (
        (this.#sequenceByItem.get(left) ?? 0) - (this.#sequenceByItem.get(right) ?? 0)
      ))
      .map(([, transcript]) => transcript)
      .join("\n");
    return `${this.#baseTranscript}\n${live}`.trim().slice(-this.#limit);
  }
}
