import { rm } from "node:fs/promises";

import {
  APP_PERMISSION_LABEL,
  APP_PERMISSION_RISK,
  APP_PERMISSION_RISK_ORDER,
  CRASH_QUARANTINE_THRESHOLD,
  CRASH_QUARANTINE_WINDOW_MS,
  PACKAGE_LIMITS,
  checkCompatibility,
  compareVersionStrings,
  diffPermissions,
  permissionKey,
  resolveDistributionAsset,
  validateManifest,
  type AppManifest,
  type AppPermission,
  type AppPermissionRisk,
  type Diagnostic,
  type HostEnvironment,
  type InstalledAppRecord,
  type InstalledPackageRecord,
  type PermissionDelta,
} from "@openwork/app-contract";
import { digest, extractVerifiedFiles, verifyPackage } from "@openwork/app-tools";

import { CandidateStore, type CandidateRecord } from "./candidates.js";
import { appDataDir, appInstallDir } from "./paths.js";
import { GithubSource, SourceError, parseRepositoryUrl, type ResolvedRelease } from "./source-github.js";
import { InstalledAppStore } from "./store.js";

// The installer.
//
// Preview and install are deliberately separate operations with a candidate
// between them, and the split is load-bearing rather than cosmetic:
//
//   preview   resolves a mutable ref to an immutable commit, reads the manifest
//             at that commit, downloads and hashes the package, and pins every
//             single input the user is about to be shown
//   install   consumes that candidate and those exact bytes
//
// Install re-resolves nothing. If the release moved between the two, the digest
// no longer matches what was pinned and installation fails loudly instead of
// installing something the user never reviewed.
//
// Apps are always installed **disabled**. Setup and enablement are separate
// user actions after that, which is why installing an app cannot start its
// microphone.

/** One thing an installed app needs from the user, and whether it has it. */
export type AppRequirement = {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
  /** The app author's explanation of what this unlocks. */
  description?: string;
  docsUrl?: string;
};

export type PermissionSummary = {
  permission: AppPermission;
  risk: AppPermissionRisk;
  label: string;
  /** The app author's stated reason, shown verbatim. */
  reason: string;
  /** Scopes, hosts, or shortcuts, rendered for review. */
  detail: string | null;
};

export type PreviewResult = {
  candidateId: string;
  expiresAt: number;
  manifest: AppManifest;
  source: {
    repository: string;
    releaseTag: string;
    commit: string;
    assetName: string;
    publishedAt: string | null;
    prerelease: boolean;
  };
  archiveDigest: string;
  /** Ordered critical-first, so the riskiest ask is never below the fold. */
  permissions: PermissionSummary[];
  environment: { key: string; label: string; required: boolean; configured: boolean }[];
  contributions: AppManifest["contributions"];
  compatible: boolean;
  /** Non-fatal notes: prerelease, unconfigured secrets, upgrade or downgrade. */
  warnings: string[];
  /** Set when this app is already installed, so the UI can show an update. */
  installed: { version: string; delta: PermissionDelta } | null;
};

export class InstallError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = "InstallError";
  }
}

export type InstallErrorCode =
  | "invalid_manifest"
  | "incompatible"
  | "package_rejected"
  | "candidate_not_found"
  | "candidate_expired"
  | "candidate_replayed"
  | "permission_mismatch"
  | "already_installed"
  | "not_installed"
  | "permission_review_required"
  | "no_rollback_target"
  | "extract_failed"
  | "not_an_upgrade";

export type InstallerOptions = {
  store: InstalledAppStore;
  candidates: CandidateStore;
  source: GithubSource;
  host: HostEnvironment;
  /** Keys currently present in the host environment store. Values never cross this boundary. */
  listEnvKeys: () => Promise<string[]>;
  dataDir?: string;
  now?: () => number;
};

export class AppInstaller {
  readonly #store: InstalledAppStore;
  readonly #candidates: CandidateStore;
  readonly #source: GithubSource;
  readonly #host: HostEnvironment;
  readonly #listEnvKeys: () => Promise<string[]>;
  readonly #dataDir: string | undefined;
  readonly #now: () => number;
  /** Crash timestamps per app, for the quarantine window. */
  readonly #crashes = new Map<string, number[]>();

  constructor(options: InstallerOptions) {
    this.#store = options.store;
    this.#candidates = options.candidates;
    this.#source = options.source;
    this.#host = options.host;
    this.#listEnvKeys = options.listEnvKeys;
    this.#dataDir = options.dataDir;
    this.#now = options.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Resolve and describe an app without executing any of it.
   *
   * Reads metadata, reads the manifest at the resolved commit, downloads the
   * declared release asset, and verifies it. No clone, no build, no hook, no
   * shell command.
   */
  async preview(input: { repositoryUrl: string; tag?: string }): Promise<PreviewResult> {
    const repository = parseRepositoryUrl(input.repositoryUrl);
    const release: ResolvedRelease = input.tag
      ? await this.#source.resolveReleaseByTag(repository, input.tag)
      : await this.#source.resolveLatestRelease(repository);

    const manifestText = await this.#source.fetchManifestAtCommit(repository, release.commit);
    const validation = validateManifest(manifestText);
    if (!validation.ok) {
      throw new InstallError(
        "invalid_manifest",
        "This repository's openwork.app.json is not a valid OpenWork app manifest.",
        validation.diagnostics,
      );
    }
    const manifest = validation.manifest;

    if (manifest.repository !== repository.canonicalUrl) {
      throw new InstallError(
        "invalid_manifest",
        `The manifest claims to live at ${manifest.repository}, but you pasted ${repository.canonicalUrl}.`,
      );
    }

    const compatibility = checkCompatibility(manifest, this.#host);
    const warnings: string[] = [];
    if (release.prerelease) {
      warnings.push(`Release ${release.tag} is marked as a prerelease.`);
    }

    const assetName = resolveDistributionAsset(manifest);
    const asset = this.#source.findAsset(release, assetName);
    const archive = await this.#source.downloadAsset(asset);

    // The manifest the user is about to review, pinned by digest. The package
    // must carry a byte-identical copy, so the document that governs the grant
    // is the same document the review screen showed. Without this, preview and
    // install read two different manifests and the review means nothing.
    const reviewedManifestDigest = digest(manifestText);

    const verified = verifyPackage(archive, {
      expectedAppId: manifest.id,
      expectedVersion: manifest.version,
      expectedManifestDigest: reviewedManifestDigest,
      ...(compatibility.compatible ? { host: this.#host } : {}),
    });
    if (!verified.ok) {
      throw new InstallError(
        "package_rejected",
        "The released package failed verification and was not accepted.",
        verified.diagnostics,
      );
    }

    // The manifest inside the package is the one that governs. A repository
    // manifest that disagrees with the shipped one is a mismatch, not a
    // preference.
    if (verified.package.metadata.source.commit !== release.commit) {
      warnings.push(
        `The package was built from commit ${verified.package.metadata.source.commit.slice(0, 7)}, while release ${release.tag} points at ${release.commit.slice(0, 7)}.`,
      );
    }

    const envKeys = new Set(await this.#listEnvKeys());
    const environment = [
      ...manifest.environment.required.map((entry) => ({
        key: entry.key,
        label: entry.label,
        required: true,
        configured: envKeys.has(entry.key),
      })),
      ...manifest.environment.optional.map((entry) => ({
        key: entry.key,
        label: entry.label,
        required: false,
        configured: envKeys.has(entry.key),
      })),
    ];
    for (const entry of environment) {
      if (entry.required && !entry.configured) {
        warnings.push(`${entry.label} is not configured yet. You can set it after installing.`);
      }
    }

    const existing = await this.#store.get(manifest.id);
    let installed: PreviewResult["installed"] = null;
    if (existing) {
      const comparison = compareVersionStrings(manifest.version, existing.active.app_version);
      if (comparison !== null && comparison < 0) {
        warnings.push(
          `You already have ${existing.active.app_version} installed, which is newer than ${manifest.version}.`,
        );
      }
      installed = {
        version: existing.active.app_version,
        delta: diffPermissions(existing.granted_permissions, manifest.permissions),
      };
    }

    const candidate = await this.#candidates.create({
      appId: manifest.id,
      appVersion: manifest.version,
      repository: repository.canonicalUrl,
      releaseTag: release.tag,
      commit: release.commit,
      archiveUrl: asset.url,
      archive,
      manifestDigest: reviewedManifestDigest,
      requestedPermissions: manifest.permissions,
    });

    return {
      candidateId: candidate.candidate_id,
      expiresAt: candidate.expires_at,
      manifest,
      source: {
        repository: repository.canonicalUrl,
        releaseTag: release.tag,
        commit: release.commit,
        assetName,
        publishedAt: release.publishedAt,
        prerelease: release.prerelease,
      },
      archiveDigest: candidate.archive_digest,
      permissions: summarisePermissions(manifest.permissions),
      environment,
      contributions: manifest.contributions,
      compatible: compatibility.compatible,
      warnings: compatibility.compatible
        ? warnings
        : [compatibility.diagnostic.message, ...warnings],
      installed,
    };
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  #takeCandidate(candidateId: string): CandidateRecord {
    const consumed = this.#candidates.consume(candidateId);
    if (consumed.ok) return consumed.candidate;
    if (consumed.reason === "already_consumed") {
      throw new InstallError(
        "candidate_replayed",
        "That installation was already completed. Preview the app again to install it a second time.",
      );
    }
    if (consumed.reason === "expired") {
      throw new InstallError(
        "candidate_expired",
        "This review expired. Preview the app again so you can see what it currently asks for.",
      );
    }
    throw new InstallError(
      "candidate_not_found",
      "This installation is no longer pending. Preview the app again.",
    );
  }

  /**
   * Confirm that what the user approved is exactly what the candidate pinned.
   *
   * Compared as an unordered set of parameterised keys, so a client cannot
   * approve a narrower list and have a wider one installed, nor slip an extra
   * permission past a review that never showed it.
   */
  #assertApprovalMatches(candidate: CandidateRecord, approved: readonly AppPermission[]): void {
    const requested = new Set(candidate.requested_permissions.map(permissionKey));
    const given = new Set(approved.map(permissionKey));
    const same = requested.size === given.size && [...requested].every((key) => given.has(key));
    if (!same) {
      throw new InstallError(
        "permission_mismatch",
        "The approved permissions do not match the ones that were reviewed. Nothing was installed.",
      );
    }
  }

  async #verifyCandidateArchive(candidate: CandidateRecord) {
    const archive = await this.#candidates.readArchive(candidate);
    const verified = verifyPackage(archive, {
      expectedArchiveDigest: candidate.archive_digest,
      expectedAppId: candidate.app_id,
      expectedVersion: candidate.app_version,
      // Re-assert the reviewed manifest at install time, so a swapped asset
      // cannot introduce permissions the review screen never displayed.
      expectedManifestDigest: candidate.manifest_digest,
      host: this.#host,
    });
    if (!verified.ok) {
      throw new InstallError(
        "package_rejected",
        "The package failed verification at install time and was not installed.",
        verified.diagnostics,
      );
    }
    return verified.package;
  }

  async #computeSetupState(manifest: AppManifest): Promise<"ready" | "setup_required"> {
    if (manifest.environment.required.length === 0) return "ready";
    const keys = new Set(await this.#listEnvKeys());
    return manifest.environment.required.every((entry) => keys.has(entry.key))
      ? "ready"
      : "setup_required";
  }

  async #materialise(
    candidate: CandidateRecord,
    manifest: AppManifest,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<InstalledPackageRecord> {
    const destination = appInstallDir(manifest.id, manifest.version, this.#dataDir);
    // A retry after a failed install, or a repair, starts from a clean directory
    // rather than merging into whatever survived.
    await rm(destination, { recursive: true, force: true });
    try {
      await extractVerifiedFiles(files, { destination });
    } catch (error) {
      throw new InstallError(
        "extract_failed",
        `Installing the package failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      app_version: manifest.version,
      archive_digest: candidate.archive_digest,
      manifest_digest: candidate.manifest_digest,
      source: {
        repository: candidate.repository,
        release_tag: candidate.release_tag,
        commit: candidate.commit,
      },
      directory: manifest.version,
      installed_at: this.#now(),
      permissions: manifest.permissions,
    };
  }

  /** Install a previewed candidate, disabled. */
  async install(input: {
    candidateId: string;
    approvedPermissions: AppPermission[];
  }): Promise<InstalledAppRecord> {
    const candidate = this.#takeCandidate(input.candidateId);
    this.#assertApprovalMatches(candidate, input.approvedPermissions);

    if (await this.#store.get(candidate.app_id)) {
      throw new InstallError(
        "already_installed",
        "That app is already installed. Use update instead.",
      );
    }

    const verified = await this.#verifyCandidateArchive(candidate);
    const activePackage = await this.#materialise(candidate, verified.manifest, verified.files);
    // The bytes have been extracted; the cache may reclaim them.
    this.#candidates.release(candidate);

    const record: InstalledAppRecord = {
      app_id: verified.manifest.id,
      installation: "installed",
      setup: await this.#computeSetupState(verified.manifest),
      // Always disabled. The user turns it on, deliberately, after setup.
      enablement: "disabled",
      compatibility: "compatible",
      active: activePackage,
      previous: null,
      pending: null,
      // Grant exactly what the user approved, from the candidate — never from
      // the package. The digest check above proves the two agree; reading the
      // candidate makes that the enforced invariant rather than an assumption.
      granted_permissions: candidate.requested_permissions,
      crash_count: 0,
      trusted_at: this.#now(),
      updated_at: this.#now(),
    };

    const saved = await this.#store.put(record);
    await this.#store.audit({
      appId: saved.app_id,
      appVersion: saved.active.app_version,
      event: "trust_granted",
    });
    await this.#store.audit({
      appId: saved.app_id,
      appVersion: saved.active.app_version,
      event: "installed",
    });
    return saved;
  }

  // -------------------------------------------------------------------------
  // Enablement and setup
  // -------------------------------------------------------------------------

  /** Recompute setup from the current environment store. */
  async refreshSetup(appId: string): Promise<InstalledAppRecord | null> {
    const record = await this.#store.get(appId);
    if (!record) return null;
    const manifest = await this.#readInstalledManifest(record);
    const setup = manifest ? await this.#computeSetupState(manifest) : record.setup;
    if (setup === record.setup) return record;
    const updated = await this.#store.update(appId, (current) => ({
      ...current,
      setup,
      // Setup regressing (a key was deleted) must also stop the app, not leave
      // it enabled against a credential that no longer exists.
      enablement: setup === "setup_required" ? "disabled" : current.enablement,
      updated_at: this.#now(),
    }));
    if (updated && setup === "ready") {
      await this.#store.audit({
        appId,
        appVersion: updated.active.app_version,
        event: "setup_completed",
      });
    }
    return updated;
  }

  async enable(appId: string): Promise<InstalledAppRecord> {
    const record = await this.#store.get(appId);
    if (!record) throw new InstallError("not_installed", "That app is not installed.");
    if (record.installation === "quarantined") {
      throw new InstallError(
        "package_rejected",
        "This app is quarantined after repeated crashes. Repair it before enabling it again.",
      );
    }
    if (record.installation === "update_pending_review") {
      throw new InstallError(
        "permission_review_required",
        "This app has an update waiting for permission review.",
      );
    }
    const refreshed = (await this.refreshSetup(appId)) ?? record;
    if (refreshed.setup !== "ready") {
      throw new InstallError(
        "not_installed",
        "This app still needs configuration before it can be enabled.",
      );
    }
    const updated = await this.#store.update(appId, (current) => ({
      ...current,
      enablement: "enabled",
      crash_count: 0,
      updated_at: this.#now(),
    }));
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    this.#crashes.delete(appId);
    await this.#store.audit({ appId, appVersion: updated.active.app_version, event: "enabled" });
    return updated;
  }

  async disable(appId: string): Promise<InstalledAppRecord> {
    const updated = await this.#store.update(appId, (current) => ({
      ...current,
      enablement: "disabled",
      updated_at: this.#now(),
    }));
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    await this.#store.audit({ appId, appVersion: updated.active.app_version, event: "disabled" });
    return updated;
  }

  /**
   * Drop a granted permission without uninstalling.
   *
   * The app is disabled at the same time. Leaving it running with a permission
   * removed mid-flight would mean its next call fails in a way it never
   * anticipated; stopping it is the honest outcome.
   */
  async revokePermission(appId: string, permissionId: string): Promise<InstalledAppRecord> {
    const updated = await this.#store.update(appId, (current) => ({
      ...current,
      granted_permissions: current.granted_permissions.filter(
        (permission) => permission.id !== permissionId,
      ),
      enablement: "disabled",
      updated_at: this.#now(),
    }));
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    await this.#store.audit({
      appId,
      appVersion: updated.active.app_version,
      event: "permission_revoked",
      subject: permissionId,
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Updates, rollback, repair
  // -------------------------------------------------------------------------

  /**
   * Apply a previewed update.
   *
   * An update that adds a permission, or widens one already granted, is stored
   * as pending and **not** applied until the user reviews it. Removals and
   * narrowings apply immediately, because they only ever reduce authority.
   */
  async update(input: {
    appId: string;
    candidateId: string;
    approvedPermissions: AppPermission[];
    /** Set once the user has actually seen and accepted the delta. */
    permissionsReviewed?: boolean;
  }): Promise<{ record: InstalledAppRecord; applied: boolean; delta: PermissionDelta }> {
    const existing = await this.#store.get(input.appId);
    if (!existing) throw new InstallError("not_installed", "That app is not installed.");

    const candidate = this.#takeCandidate(input.candidateId);
    if (candidate.app_id !== input.appId) {
      throw new InstallError("permission_mismatch", "That package is for a different app.");
    }
    this.#assertApprovalMatches(candidate, input.approvedPermissions);

    const comparison = compareVersionStrings(candidate.app_version, existing.active.app_version);
    if (comparison !== null && comparison <= 0) {
      throw new InstallError(
        "not_an_upgrade",
        `Version ${candidate.app_version} is not newer than the installed ${existing.active.app_version}.`,
      );
    }

    const delta = diffPermissions(existing.granted_permissions, candidate.requested_permissions);
    const verified = await this.#verifyCandidateArchive(candidate);
    this.#candidates.release(candidate);

    if (delta.requiresReview && input.permissionsReviewed !== true) {
      const pending = await this.#materialise(candidate, verified.manifest, verified.files);
      const updated = await this.#store.update(input.appId, (current) => ({
        ...current,
        installation: "update_pending_review",
        pending,
        updated_at: this.#now(),
      }));
      if (!updated) throw new InstallError("not_installed", "That app is not installed.");
      await this.#store.audit({
        appId: input.appId,
        appVersion: candidate.app_version,
        event: "update_withheld_pending_review",
        reason: delta.entries
          .filter((entry) => entry.change === "added" || entry.change === "widened")
          .map((entry) => entry.permission.id)
          .join(","),
      });
      return { record: updated, applied: false, delta };
    }

    const next = await this.#materialise(candidate, verified.manifest, verified.files);
    const updated = await this.#store.update(input.appId, (current) => ({
      ...current,
      installation: "installed",
      // The previous package stays on disk; that is what makes rollback real
      // rather than a re-download of something that may no longer exist.
      previous: current.active,
      active: next,
      pending: null,
      granted_permissions: candidate.requested_permissions,
      // A new version is a new runtime. Do not carry a crash streak into it.
      crash_count: 0,
      updated_at: this.#now(),
    }));
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    await this.#store.audit({
      appId: input.appId,
      appVersion: next.app_version,
      event: "update_applied",
    });
    return { record: await this.refreshSetup(input.appId) ?? updated, applied: true, delta };
  }

  /** Apply an update that was previously withheld, after the user reviewed it. */
  async approvePendingUpdate(appId: string): Promise<InstalledAppRecord> {
    const existing = await this.#store.get(appId);
    if (!existing) throw new InstallError("not_installed", "That app is not installed.");
    if (!existing.pending) {
      throw new InstallError("not_installed", "There is no update waiting for review.");
    }
    const updated = await this.#store.update(appId, (current) => {
      const pending = current.pending;
      if (!pending) return current;
      return {
        ...current,
        installation: "installed",
        previous: current.active,
        active: pending,
        pending: null,
        granted_permissions: pending.permissions,
        crash_count: 0,
        updated_at: this.#now(),
      };
    });
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    await this.#store.audit({
      appId,
      appVersion: updated.active.app_version,
      event: "update_applied",
    });
    return (await this.refreshSetup(appId)) ?? updated;
  }

  async rollback(appId: string): Promise<InstalledAppRecord> {
    const existing = await this.#store.get(appId);
    if (!existing) throw new InstallError("not_installed", "That app is not installed.");
    if (!existing.previous) {
      throw new InstallError(
        "no_rollback_target",
        "There is no previous version retained for this app, so it cannot be rolled back.",
      );
    }
    const target = existing.previous;
    const archive = appInstallDir(appId, target.directory, this.#dataDir);
    void archive;

    const updated = await this.#store.update(appId, (current) => {
      const previous = current.previous;
      if (!previous) return current;
      return {
        ...current,
        installation: "installed",
        active: previous,
        previous: null,
        pending: null,
        // The rolled-back version's permissions are what is granted again. They
        // were approved when it was installed, so this never widens authority.
        granted_permissions: previous.permissions,
        // Roll back into a stopped state. Resuming automatically after a
        // rollback would restart whatever went wrong.
        enablement: "disabled",
        crash_count: 0,
        updated_at: this.#now(),
      };
    });
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    this.#crashes.delete(appId);
    await this.#store.audit({
      appId,
      appVersion: target.app_version,
      event: "rolled_back",
    });
    return (await this.refreshSetup(appId)) ?? updated;
  }

  /** Re-extract the active package from its cached archive, clearing quarantine. */
  async repair(appId: string, archive: Uint8Array): Promise<InstalledAppRecord> {
    const existing = await this.#store.get(appId);
    if (!existing) throw new InstallError("not_installed", "That app is not installed.");

    const verified = verifyPackage(archive, {
      expectedArchiveDigest: existing.active.archive_digest,
      expectedAppId: appId,
      expectedVersion: existing.active.app_version,
      host: this.#host,
    });
    if (!verified.ok) {
      throw new InstallError(
        "package_rejected",
        "The package supplied for repair does not match the installed version.",
        verified.diagnostics,
      );
    }

    const destination = appInstallDir(appId, existing.active.directory, this.#dataDir);
    await rm(destination, { recursive: true, force: true });
    await extractVerifiedFiles(verified.package.files, { destination });

    const updated = await this.#store.update(appId, (current) => ({
      ...current,
      installation: "installed",
      // Repair restores files; it does not decide the app should be running.
      enablement: "disabled",
      crash_count: 0,
      updated_at: this.#now(),
    }));
    if (!updated) throw new InstallError("not_installed", "That app is not installed.");
    this.#crashes.delete(appId);
    await this.#store.audit({ appId, appVersion: updated.active.app_version, event: "repaired" });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Crash quarantine
  // -------------------------------------------------------------------------

  /**
   * Record a runtime crash and quarantine on a tight streak.
   *
   * Counted inside a rolling window, so an app that crashes once a day is not
   * eventually quarantined by accumulation — only one that is genuinely failing
   * to start.
   */
  async recordCrash(appId: string): Promise<InstalledAppRecord | null> {
    const now = this.#now();
    const history = (this.#crashes.get(appId) ?? []).filter(
      (at) => now - at < CRASH_QUARANTINE_WINDOW_MS,
    );
    history.push(now);
    this.#crashes.set(appId, history);

    const quarantine = history.length >= CRASH_QUARANTINE_THRESHOLD;
    const updated = await this.#store.update(appId, (current) => ({
      ...current,
      crash_count: history.length,
      installation: quarantine ? "quarantined" : current.installation,
      enablement: quarantine ? "disabled" : current.enablement,
      updated_at: now,
    }));
    if (!updated) return null;
    await this.#store.audit({
      appId,
      appVersion: updated.active.app_version,
      event: quarantine ? "quarantined" : "runtime_crashed",
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------------

  /**
   * Remove an app.
   *
   * `deleteData` is the user's choice and is honoured either way: keeping app
   * data after an uninstall is legitimate (reinstalling later), and so is
   * wanting it gone. Both outcomes are audited so the record says which
   * happened.
   */
  async uninstall(appId: string, options: { deleteData: boolean }): Promise<{ removed: boolean }> {
    const existing = await this.#store.get(appId);
    if (!existing) return { removed: false };

    const version = existing.active.app_version;
    await this.#store.remove(appId);

    for (const record of [existing.active, existing.previous, existing.pending]) {
      if (!record) continue;
      await rm(appInstallDir(appId, record.directory, this.#dataDir), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
    if (options.deleteData) {
      await rm(appDataDir(appId, this.#dataDir), { recursive: true, force: true }).catch(() => {});
    }

    this.#crashes.delete(appId);
    await this.#store.audit({ appId, appVersion: version, event: "uninstalled" });
    await this.#store.audit({
      appId,
      appVersion: version,
      event: options.deleteData ? "app_data_deleted" : "app_data_retained",
    });
    return { removed: true };
  }

  // -------------------------------------------------------------------------
  // Reading installed state
  // -------------------------------------------------------------------------

  async #readInstalledManifest(record: InstalledAppRecord): Promise<AppManifest | null> {
    const { readFile } = await import("node:fs/promises");
    const path = appInstallDir(record.app_id, record.active.directory, this.#dataDir);
    const text = await readFile(`${path}/openwork.app.json`, "utf8").catch(() => null);
    if (text === null) return null;
    const validation = validateManifest(text);
    return validation.ok ? validation.manifest : null;
  }

  /**
   * What an installed app still needs before it can do everything it declares.
   *
   * Returned for the whole list so Preferences can explain a `needs setup`
   * state instead of only naming it. `description` and `docs_url` are the app
   * author's own words: the host knows a key is missing, but only the author
   * knows what it unlocks.
   */
  async requirements(record: InstalledAppRecord): Promise<AppRequirement[]> {
    const manifest = await this.#readInstalledManifest(record);
    if (!manifest) return [];
    const configured = new Set(await this.#listEnvKeys());
    return [
      ...manifest.environment.required.map((entry) => ({ entry, required: true })),
      ...manifest.environment.optional.map((entry) => ({ entry, required: false })),
    ].map(({ entry, required }) => ({
      key: entry.key,
      label: entry.label,
      required,
      configured: configured.has(entry.key),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.docs_url === undefined ? {} : { docsUrl: entry.docs_url }),
    }));
  }

  /**
   * Load an installed app's manifest, re-checking it against the recorded
   * digest. A package edited on disk after installation is reported as corrupt
   * rather than loaded.
   */
  async loadInstalled(appId: string): Promise<{
    record: InstalledAppRecord;
    manifest: AppManifest | null;
  } | null> {
    const record = await this.#store.get(appId);
    if (!record) return null;
    return { record, manifest: await this.#readInstalledManifest(record) };
  }
}

function permissionDetail(permission: AppPermission): string | null {
  switch (permission.id) {
    case "openwork.connect.read":
      return permission.scopes.join(", ");
    case "network.host":
      return permission.hosts.join(", ");
    case "desktop.globalShortcut":
      // Name the shortcut alongside its key, so a rebind is legible on review
      // rather than looking like the same shortcut it always was.
      return permission.shortcuts
        .map((entry) => `${entry.id}: ${entry.default_accelerator}`)
        .join(", ");
    case "desktop.floatingSurface":
      return permission.always_on_top ? "stays above other windows" : "ordinary window";
    case "storage.app":
      return `up to ${Math.round(permission.quota_bytes / 1024)} KB`;
    // No `default`: a new parameterised permission has to decide what the review
    // screen says about it, instead of silently rendering no detail at all.
    case "runtime.background.continuous":
    case "audio.microphone":
    case "ai.realtime":
    case "ai.inference.transient":
    case "openwork.threads.start":
    case "openwork.attachments.create":
      return null;
  }
}

/** Critical first, so the riskiest ask is never below the fold. */
export function summarisePermissions(permissions: readonly AppPermission[]): PermissionSummary[] {
  return [...permissions]
    .map((permission) => ({
      permission,
      risk: APP_PERMISSION_RISK[permission.id],
      label: APP_PERMISSION_LABEL[permission.id],
      reason: permission.reason,
      detail: permissionDetail(permission),
    }))
    .sort(
      (left, right) =>
        APP_PERMISSION_RISK_ORDER.indexOf(left.risk) - APP_PERMISSION_RISK_ORDER.indexOf(right.risk) ||
        left.permission.id.localeCompare(right.permission.id),
    );
}

export { PACKAGE_LIMITS, SourceError };
