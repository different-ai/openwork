# Attachment Request Metadata

Approved bug-fix proof for attachment metadata preservation.

1. “I attach `PassaportoPaolo_small.jpg`; OpenWork records the original filename and detects `image/jpeg`.”

2. “A mocked responses request shows the same filename, extension, MIME type, and image bytes reaching the provider adapter.”

3. “An automated regression test confirms a JPG cannot be mislabeled as a PDF anywhere in the attachment pipeline.”
