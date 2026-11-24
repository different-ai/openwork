# Questions in the conversation (`questionInThread`)

- **Feature key:** `questionInThread`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default

## What people get

When an agent asks a question, it appears as a card at the end of the
conversation instead of above the message box. The person can scroll the
conversation and keep using the message box while the question waits.

The card shows "Needs your input", the question, and one row per option with a
radio (or a checkbox for multiple choice). **Other** opens a text field for a
typed answer. **Submit** sends the answer; picking an option no longer answers
on its own. **Skip** at the bottom declines the question.

Sending a message from the message box while a question waits skips the
question first, then sends the message. The card says so next to **Skip**.

Off, the question opens above the message box, as before.

## Forms from the agent (prototype)

With `OPENWORK_ASK_FORM=1` in the server's environment, agents get an
`ask_form` tool. It asks several things in one card: choices as rows, cards
with an icon and a short description, or tiles; a scale with labels at both
ends; a date; or free text. Options may be marked as cost, risk or safe.

It uses the engine's standard v2 form: each field is a `string` or
`multiselect` form field, and the layout rides in `metadata.form`. An app that
does not know the layout shows each field as a plain question. Answers come
back as one message, like `ask_without_waiting`.
