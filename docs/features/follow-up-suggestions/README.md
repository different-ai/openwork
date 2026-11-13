# Suggested follow-ups (`followUpSuggestions`)

- **Feature key:** `followUpSuggestions`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

After a reply finishes, the empty message box can show a suggested next
message in gray where the usual placeholder is, followed by a **Tab** key
hint. **Tab** puts the suggestion in the message box to edit or send. Typing,
pasting or attaching anything ignores it.

Suggestions predict what the person is likely to type, matching their language,
tone and brevity. A short confirmation, correction or question can be enough;
the model should not invent a detailed task or automatically accept an optional
next step offered by the assistant. It prefers 2–8 words, with a 12-word maximum
in the prompt.

Nothing shows when the next message is unclear, several directions are equally
plausible, or the conversation is finished. The model is told to answer `NONE`
in those cases, and the app also drops answers that are empty, longer than 120
characters or more than one line.

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
chat, so it adds nothing to the chat's history or context. The prompt holds up to
eight recent user/assistant text messages, newest first for budget allocation
and then restored to conversation order. The total text budget is 6,000
characters, with at most 1,500 per user message and 2,000 per assistant message.
Long messages keep their beginning and end so a closing offer does not replace
the actual result or an earlier request's correction. Tool results, reasoning
and system messages are excluded; nothing is retrieved from other chats or apps.

This follows the interaction described in OpenAI's
[Composer Predictions documentation](https://learn.chatgpt.com/docs/features/composer-predictions).
The public Codex repository contains prediction protocol types and tests for
inheriting conversation context, but the checked revision's
[`thread/prediction/request` handler](https://github.com/openai/codex/blob/b279cfb170df7bd2f6dc891cd08d032116533efb/codex-rs/app-server/src/message_processor.rs)
returns “not implemented yet.” This is an independently written prompt, not a
copy of Codex's prediction prompt or a claim of identical model outputs.

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
natural continuation to see a suggestion, and something closed (for example
"what is 2 + 2?") to see none. Also try a short reply such as "the second one"
after asking for two casual outlines: any suggestion should still fit that
original intent, even if the assistant offers an unrelated detailed calendar.

`apps/app/tests/follow-up-suggestion.test.ts` covers which replies are asked
about, the prompt, which answers are shown, and the model choice.
