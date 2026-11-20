# PowerPoint and Word outlines

- Key: `officeOutlinePreview`
- Deployments: cloud and self-hosted; off by default
- Owner: `benjaminshafii`

When enabled, opening a `.pptx` or `.docx` file from desktop chat shows its text in the same side panel. PowerPoint slides appear in deck order, including slides without text. Word documents show body headings and paragraphs. Formatting, images, and slide notes aren't shown. The panel still offers **Open externally** wherever it did before.

To try it, enable the flag for a test member or organization, then open a PowerPoint and Word file from chat. Check the order and readable text, try an empty or unreadable file, and confirm `.ppt`, `.key`, and `.odp` still show the old fallback. Signed-out desktop uses the deployment setting. Turning the flag off returns to the previous preview message without changing files. Check feature usage in `/admin` and watch for missing outlines or excessive size-limit fallbacks with ordinary files.
