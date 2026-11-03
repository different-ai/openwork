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

- PDFs up to 10 MB are downloaded (`alt=media`), parsed in-process with
  `unpdf` (pdf.js, no fonts loaded) and their text layer returned, pages
  separated by a blank line. The same 200,000-character limit as other text
  reads applies; `truncated: true` marks a cut. Parsing stops at the page that
  reaches the limit.
- A PDF with no text layer (a scan) returns
  `contentUnavailableReason: "no_extractable_text"`, or base64 if it is under
  64 KB as before.
- Over 10 MB, or a file pdf.js cannot open and that is over 64 KB, still
  returns `file_too_large`.
- Other file types are unchanged. Only the text reaches the model; the PDF
  bytes are never returned.

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

`/v1/capabilities/google-workspace/drive-file/:fileId` latency and memory on
the Den API (a 10 MB PDF is held in memory while parsed), and Google Drive 4xx
errors on the content download.
