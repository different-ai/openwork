# Suggested follow-ups (`followUpSuggestions`)

- **Feature key:** `followUpSuggestions`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

After a reply finishes, the empty message box can show a suggested next
message in gray where the usual placeholder is, followed by a **Tab** key
hint. **Tab** puts the suggestion in the message box to edit or send. Typing,
pasting or attaching anything ignores it.

Nothing shows unless there is a clear next step. The model is told to answer
`NONE` when it has none, and the app also drops answers that are empty, longer
than 120 characters or more than one line.

A suggestion is asked for only:

- on OpenCode v2 chats, for a reply that finished while the chat was open
  (opening an older chat asks nothing);
- once the chat has been settled for a moment: nothing running or queued, no
  open question or permission request, and no error;
- once per reply. The answer is kept in memory for the 50 most recent chats,
  so switching chats and coming back does not ask again;
- in main chats, not in sub-agent chats or archived ones.

## How the suggestion is written

One stateless engine request (`POST /api/experimental/generate`), outside the
chat, so it adds nothing to the chat's history or context. The prompt holds
only the last request (first 1,500 characters) and the last reply (last 4,000
characters).

The model is chosen the way the engine chooses one for chat titles: the small
model of the chat's provider (`gpt-luna`, `gemini-flash-lite`, `gemini-flash`,
`claude-haiku`, in that order), otherwise the chat's own model. Either runs at
its lowest effort when it has one. On a provider with no small model, such as
the Smart Router, the request therefore goes to the chat's model.

Any failure (request refused, model unavailable, no usable answer) shows the
usual placeholder. Nothing is reported to the person.

## Off

Turning it off stops the requests and shows the usual placeholder. Nothing is
stored, so it is safe to turn off at any moment.

## Try it

Turn the feature on for an organization, send a message in a chat, and wait
for the reply to finish with the message box empty. Ask for something with an
obvious next step (for example "draft a plan for X") to see a suggestion, and
something closed (for example "what is 2 + 2?") to see none.

`apps/app/tests/follow-up-suggestion.test.ts` covers which replies are asked
about, the prompt, which answers are shown, and the model choice.
