# Chat file references: text, candidates, and identity

A file reference is not yet a file identity. A filename can be literal inline
code, a URL-encoded Markdown destination, shorthand under a directory in the
same reply, or an output on another runtime. Treating all four as a workspace
relative path produces both false “missing” notices and wrong-file opens.

## Why earlier fixes did not cover directory handoffs

The history established necessary boundaries, but each addressed a different
stage rather than retaining context through the whole pipeline:

- `a2bb57ef8e`: preserve explicit paths and reject relative traversal.
- #5064 (`e79d3bce1b`, including `e560562ce7` / `1e3fcb124e`): resolve explicit
  clicks without waiting for artifact discovery; canonicalize before native
  launch, rather than trusting renderer containment checks.
- #5456 (`4a3b060b8a`): avoid attaching whitespace-truncated prompt paths.
  Prompt attachment detection is distinct from rendered chat references.
- `26a76a4106`: localized explicit links must not depend on English artifact
  verbs. Direct click resolution remains independent of discovery heuristics.
- #6230 (`45b2dfdc05`): use the actual opened folder for generated destinations.
  Resolution must prefer reported actual destinations over requested paths.
- #6803 (`d2815687f9`): a shared path reader handles home paths, location suffixes,
  quotes and encoding; bounded workspace search handles incomplete references.
- #6805 (`6717528286`): preserve runtime/root ownership, recheck stale references,
  and offer a calm Copy path fallback rather than OS errors or remote-to-local
  fallback.

Those fixes could parse `~/Desktop/OpenWork open-model benchmark/report.md`,
but a click on just `report.md` discarded the preceding directory. Searching
only the workspace could never find that outside-workspace output. A same-named
workspace file could also incorrectly win. The previous notice claimed the
file was “no longer available” even when its actual location was never checked.

## One resolution pipeline

1. **Parse once by source semantics.** `artifacts/local-path.ts` reads literal
   code without URL decoding, decodes link destinations once, strips location
   metadata, and rejects schemes, network shares, control characters and relative
   traversal. Spaces, Unicode, and literal percent signs stay part of the name.
2. **Carry occurrence-local context.** `artifacts/path-reference-context.ts`
   finds the nearest preceding inline directory declaration in the rendered
   message. A declaration ends with `/` or `\\`; no English wording is required.
   Later declarations never rewrite earlier links. Fenced examples and listed
   child directories (`scenes/` among sibling outputs) do not replace the base.
   This works identically across streamed blocks and settled messages.
3. **Collect session evidence separately from sidebar discovery.**
   `deriveSessionFileEvidence` reads exact structured file paths from completed,
   successful tool calls, including reads and patch metadata. It respects actual
   file-destination metadata, preserves case/prefixes, and excludes discovery
   tools and error results. Raw command strings and arbitrary prose are not
   filesystem evidence. Ambiguous suffix evidence is not selected arbitrarily.
4. **Check candidates before searching.** `planFileOpen` checks the contextual
   path, the written path, and a unique matching session file identity exactly;
   only then does it request the existing bounded workspace/conversation search.
   Already verified/scoped targets remain pinned and never select a replacement
   after deletion. Absolute/home references are not rebound by contextual hints.
5. **Verify on the owning runtime.** Workspace checks use the existing server
   resolver, retaining workspace/conversation scope through previews and downloads.
   Only a local-origin desktop session may call `__resolveChatFilePath`, a
   read-only canonicalization/existence probe. It neither launches nor grants
   access. Remote/unknown origins never probe this computer, including on errors.
6. **Act under the existing native policy.** Existing workspace files may open;
   outside-workspace files are revealed only. The main process rechecks existence
   and realpath containment at activation, including symlinks. Missing files do
   not reveal their parent. Installed-app authorization remains unchanged.
7. **Degrade without inventing history.** A miss says OpenWork could not find the
   file, with Copy path; it does not claim the file was deleted. Video loading,
   inline clicks, keyboard activation and link menus use the same resolver.
   Unstreamable videos fall back to their file reference, not a broken player.

Context is a bounded hint, not a filesystem grant or a model assertion of
existence. We intentionally do not recursively search a person's entire home,
interpret shell commands, or infer arbitrary unquoted directory prose. The
existing bounded workspace search is the final compatibility fallback.

## Verification

- `apps/app/tests/chat-file-links.test.ts`: historical parsing, ownership,
  native policy, discovery-independent clicks and stale-file regressions.
- `apps/app/tests/chat-file-context.test.tsx`: occurrence-local directories,
  mouse/keyboard/menu and streamed rendering, candidate order, tool evidence,
  encoding, ambiguity, and remote/native boundaries.
- `apps/app/tests/chat-file-native-resolution.test.ts`: real temporary home,
  spaced Desktop directory, video outside workspace, same-named decoy, actual
  native existence probe, reveal-only dispatch, and deletion without rebinding.
- `apps/desktop/electron/workspace-file-access.test.mjs`: realpath, missing,
  directory, symlink, launch/reveal and parent-fallback guards on Node.
- `evals/proofs/chat-file-context.proof.test.ts`: real headless app and workspace
  runtime; two handoffs with identical report names must open their own preview,
  not the root decoy, and a missing attachment keeps its calm fallback.
