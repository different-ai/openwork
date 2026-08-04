# google-workspace-gmail-draft-attachments — Upload workspace files without model-visible bytes

1. I give OpenWork a workspace file path for a Drive upload or Gmail draft attachment; the model never has to encode or carry the file bytes.

2. OpenWork sends the file directly through an authenticated multipart request and immediately performs the Google operation without staging or storing a copy.

3. The uploaded Drive file or Gmail attachment preserves the workspace bytes, filename, and MIME type, including Office formats, and OpenWork returns the provider result for review.
