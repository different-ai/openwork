---
name: upload-photo
description: Attach a screenshot/image/video to a PR or issue, or embed an image in a GitHub comment.
---

# Upload Photo

Use GitHub CLI 2.99 or newer. Check and upgrade it if needed:

```sh
gh --version
brew upgrade gh
```

Attach a file to a new comment, putting alt text after `#`:

```sh
gh pr comment <n> --attach './shot.png#Alt text'
gh issue comment <n> --attach './shot.png#Alt text'
```

`gh pr create`, `gh pr edit`, `gh issue create`, and `gh issue edit` also accept repeatable `--attach` flags, with at most 50 files.

To place an image in the body, reference the same path:

```sh
printf '![Alt text](./shot.png)\n' | gh pr comment <n> --body-file - --attach './shot.png#Alt text'
```

GitHub rewrites that Markdown reference to the uploaded asset. Unreferenced attachments are appended to the comment.

There is no standalone “get a URL” command. The asset URL lives in the posted comment; read it back with `gh api repos/{owner}/{repo}/issues/comments/<id> --jq .body`.
