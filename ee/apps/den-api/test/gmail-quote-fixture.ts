// Synthetic mail only; shared by the regression tests and quote-rendering preview.
export const from = "Example Sender <sender@example.test>"
export const date = "Wed, 14 Oct 2026 16:50:00 +0000"
export const html = '<div>Latest reply</div><div><a href="https://example.test/notes">Project notes</a></div><table><tr><td>Milestone</td><td>Complete</td></tr></table><blockquote class="gmail_quote" style="border-left:1px solid rgb(204,204,204);padding-left:1ex"><div>Earlier reply</div><blockquote class="gmail_quote" style="border-left:1px solid rgb(204,204,204);padding-left:1ex"><div>Original question</div></blockquote></blockquote>'
export const plain = "Latest reply\nProject notes\nMilestone Complete\n> Earlier reply\n> > Original question"
export const part = (mimeType: string, text: string) => ({ mimeType, body: { data: Buffer.from(text).toString("base64url") } })
export const message = (parts = [part("text/plain", plain), part("text/html", html)]) => ({ payload: { headers: [{ name: "From", value: from }, { name: "Date", value: date }, { name: "Message-ID", value: "<sent@example.test>" }, { name: "References", value: "<root@example.test>" }], parts } })
