# Google Drive PDF text

- Feature: `googleDrivePdfText`
- Deployments: cloud and self-hosted; default **off**
- Owner: `benjaminshafii`

## What changes

`GET /v1/capabilities/google-workspace/drive-file/:fileId` (the Drive "read
file" capability agents call through the MCP gateway, including the Slack
agent) returns a PDF's extracted text in `content` with `encoding: "text"`.

Before, a PDF was treated like any other binary file: anything over 64 KB came
back with `content: null` and `contentUnavailableReason: "file_too_large"`, and
anything smaller came back as base64 the model cannot read. So an ordinary
few-hundred-KB PDF was reported as "too large" and the agent got nothing.

With the feature on:

- PDFs up to **50 MB** are downloaded (`alt=media`) and their text layer is
  returned, pages separated by a blank line. The same 200,000-character limit
  as other text reads applies; `truncated: true` marks a cut. Extraction stops
  at the page that reaches the limit.
- Only the text reaches the model; the PDF bytes are never returned. Other
  file types, and their 64 KB inline limit, are unchanged.
- When there is no text, `content` is null, `contentUnavailableReason` says
  why and `contentUnavailableHint` tells the agent what to do instead (with a
  shell: `createGoogleDriveDownloadLink`, download, read locally; otherwise
  tell the person):
  - `file_too_large`: over 50 MB (by Drive's size or while downloading).
  - `no_extractable_text`: no text layer, such as a scan. Under 64 KB it still
    comes back as base64, as before.
  - `extraction_timed_out`: reading took longer than 15 seconds.

## Why 50 MB, and how it stays safe on a shared server

pdf.js needs the whole file (the cross-reference table is at the end), so the
PDF is held in memory while it is read. To keep that bounded:

- The download is streamed with the limit enforced while reading: a declared
  size over 50 MB is refused before reading, and a body that grows past its
  declared size or the limit is cut off. A declared size is read into one
  buffer, not chunks plus a copy.
- Extraction runs in a worker thread with a 512 MB heap limit. The buffer is
  transferred to it, not copied. pdf.js parses synchronously, so on the
  request thread it would stall other requests and no timer could stop it;
  the worker is terminated at the 15-second deadline instead.
- At most two extractions run at once per server; more wait their turn.
- The pdf.js document is destroyed after every read.

Measured with generated 200-page, image-heavy PDFs (Apple M3 Max,
`node --import tsx scripts/measure-pdf-text.ts 10 25 50` in `ee/apps/den-api`;
nothing is stored, the PDFs are built in memory):

| File | Shape | Time | Memory above the file | Longest stall of other work |
|---|---|---|---|---|
| 50 MB | text and images | 0.24 s | 64 MB | 1 ms |
| 50 MB | scan (no text) | 0.16 s | 54 MB | 1 ms |
| 50 MB | broken cross-reference table (worst case) | 0.55 s | 263 MB | 2 ms |
| 25 MB | broken cross-reference table | 0.40 s | 157 MB | 2 ms |
| 10 MB | broken cross-reference table | 0.29 s | 94 MB | 2 ms |

So two worst-case 50 MB reads at once need about 650 MB including the files,
within the Den API's memory, and requests on the same server keep moving.

## Try it

1. Turn `googleDrivePdfText` on for a test organization (or member) in
   `/admin` › Features.
2. Connect Google Workspace with Read all Drive files enabled and ask an agent
   to read a PDF of a few hundred KB from Drive. It should quote its text.
3. Turn the feature off: the same read returns `file_too_large` again.

## Turning it off

The check runs per request, so the kill switch takes effect on the next read.
Nothing is stored; turning it off only changes what later reads return.

## What to watch

`/v1/capabilities/google-workspace/drive-file/:fileId` latency, Den API memory,
and Google Drive 4xx errors on the content download.
