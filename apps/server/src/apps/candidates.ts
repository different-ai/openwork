import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  INSTALL_CANDIDATE_TTL_MS,
  type AppPermission,
  type InstallCandidate,
} from "@openwork/app-contract";

import { candidateCacheDir } from "./paths.js";

// Install candidates.
//
// This is the mechanism that closes the gap between "the user reviewed these
// permissions" and "these bytes were installed". Preview resolves a mutable ref
// to an immutable commit, downloads the archive, hashes it, and pins every
// input the user was shown. Install then consumes the candidate and the cached
// bytes — it never re-resolves the release, never refetches metadata, and never
// accepts an archive whose digest differs from the pinned one.
//
// Candidates are single-use and short-lived. A replayed candidate id is a
// distinct, reported failure rather than a second silent install.

export type CandidateRecord = InstallCandidate & {
  /** Absolute path to the archive downloaded and verified during preview. */
  archivePath: string;
};

export type ConsumeFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "already_consumed" };

export type ConsumeResult = { ok: true; candidate: CandidateRecord } | ConsumeFailure;

export type CandidateStoreOptions = {
  dataDir?: string;
  ttlMs?: number;
  now?: () => number;
};

export class CandidateStore {
  readonly #candidates = new Map<string, CandidateRecord>();
  /** Ids already spent, so a replay is reported rather than treated as unknown. */
  readonly #consumed = new Set<string>();
  /**
   * When each cached archive was written, on the same clock everything else
   * uses. Reading `mtime` instead would mix a real filesystem timestamp with an
   * injectable clock, and the sweep would silently never reclaim anything.
   */
  readonly #writtenAt = new Map<string, number>();
  /** Paths being written right now, so a concurrent sweep cannot delete them. */
  readonly #reserved = new Set<string>();
  /** Archives a consumed candidate is still installing from. */
  readonly #retained = new Set<string>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cacheDir: string;

  constructor(options: CandidateStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? INSTALL_CANDIDATE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#cacheDir = candidateCacheDir(options.dataDir);
  }

  get cacheDir(): string {
    return this.#cacheDir;
  }

  /**
   * Store the archive and mint a candidate bound to it.
   *
   * The archive is written under its own digest, so two previews of the same
   * release share bytes and a tampered archive can never occupy the name of a
   * good one.
   */
  async create(input: {
    appId: string;
    appVersion: string;
    repository: string;
    releaseTag: string;
    commit: string;
    archiveUrl: string;
    archive: Uint8Array;
    manifestDigest: string;
    requestedPermissions: AppPermission[];
  }): Promise<CandidateRecord> {
    const digest = `sha256:${createHash("sha256").update(input.archive).digest("hex")}`;
    const archivePath = join(this.#cacheDir, `${digest.replace("sha256:", "")}.owapp`);
    this.#reserved.add(archivePath);
    try {
      await mkdir(this.#cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(archivePath, input.archive, { mode: 0o600 });
    } finally {
      this.#reserved.delete(archivePath);
    }
    this.#writtenAt.set(archivePath, this.#now());

    const createdAt = this.#now();
    const candidate: CandidateRecord = {
      candidate_id: randomBytes(24).toString("hex"),
      app_id: input.appId,
      app_version: input.appVersion,
      repository: input.repository,
      release_tag: input.releaseTag,
      commit: input.commit,
      archive_url: input.archiveUrl,
      archive_digest: digest,
      manifest_digest: input.manifestDigest,
      requested_permissions: input.requestedPermissions,
      created_at: createdAt,
      expires_at: createdAt + this.#ttlMs,
      archivePath,
    };
    this.#candidates.set(candidate.candidate_id, candidate);
    return candidate;
  }

  peek(candidateId: string): CandidateRecord | null {
    const candidate = this.#candidates.get(candidateId);
    if (!candidate) return null;
    if (candidate.expires_at <= this.#now()) return null;
    return candidate;
  }

  /** Take a candidate exactly once. */
  consume(candidateId: string): ConsumeResult {
    if (this.#consumed.has(candidateId)) return { ok: false, reason: "already_consumed" };
    const candidate = this.#candidates.get(candidateId);
    if (!candidate) return { ok: false, reason: "not_found" };
    if (candidate.expires_at <= this.#now()) {
      this.#candidates.delete(candidateId);
      return { ok: false, reason: "expired" };
    }
    this.#candidates.delete(candidateId);
    this.#consumed.add(candidateId);
    // The installer still needs these bytes. Hold them until it says otherwise.
    this.#retained.add(candidate.archivePath);
    return { ok: true, candidate };
  }

  /** Read back the archive a candidate pinned. */
  async readArchive(candidate: CandidateRecord): Promise<Uint8Array> {
    return readFile(candidate.archivePath);
  }

  /** Installation finished with these bytes; the sweep may reclaim them. */
  release(candidate: CandidateRecord): void {
    this.#retained.delete(candidate.archivePath);
  }

  /** Drop expired candidates and the cached archives nothing references. */
  async sweep(): Promise<{ candidates: number; archives: number }> {
    const now = this.#now();
    let removedCandidates = 0;
    for (const [id, candidate] of this.#candidates) {
      if (candidate.expires_at <= now) {
        this.#candidates.delete(id);
        removedCandidates += 1;
      }
    }

    const live = new Set([...this.#candidates.values()].map((candidate) => candidate.archivePath));
    let removedArchives = 0;
    const entries = await readdir(this.#cacheDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const path = join(this.#cacheDir, entry);
      if (live.has(path) || this.#reserved.has(path) || this.#retained.has(path)) continue;
      const writtenAt = this.#writtenAt.get(path);
      // A file this process did not write is a leftover from a previous run: no
      // live candidate can reference it, so it goes. One we did write waits out
      // the TTL, on the same clock as everything else.
      if (writtenAt !== undefined && now - writtenAt < this.#ttlMs) continue;
      await rm(path, { force: true }).catch(() => {});
      this.#writtenAt.delete(path);
      removedArchives += 1;
    }
    return { candidates: removedCandidates, archives: removedArchives };
  }
}
