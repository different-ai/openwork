# Agents ask and keep working (`agentQuestions`)

- **Feature key:** `agentQuestions`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

On the desktop with OpenCode v2, agents stop ending a turn with requests like
"allow this, then let me know". They ask in the chat instead and continue on
their own once you answer.

- When nothing useful can continue until you answer, the agent uses the
  engine's own question tool, which waits for your answer, as before.
- When other parts of the task don't depend on the answer, it asks with
  `ask_without_waiting` and keeps working. The question shows in the usual
  question card above the composer, and the sidebar shows **Question**.
- Your answer is sent to the chat as a message from you. A running agent reads
  it at its next step; if the agent has already finished, the answer starts a
  new turn and it picks up from there.
- Dismissing the question sends nothing.

## How it works

- The renderer reports the feature to the desktop (`agentQuestionsSetEnabled`);
  the desktop's UI bridge answers `GET /agent-questions/enabled`. The engine
  plugin (`openwork-context-v2.ts`) checks it before each prompt, like
  `computerUse`, and offers `ask_without_waiting` only while it is on. Any
  other host, such as a cloud worker, leaves it off.
- All model-facing guidance is that tool's description
  (`openwork-agent-questions.ts`), so a chat without the feature never reads it.
- The server's context bridge creates a v2 form through the engine's standard
  Form API, with the question tool's `metadata.kind: "question"` and no tool
  link, so the app shows it like any question and keeps it open after the tool
  call returns (`opencode-v2-background-questions.ts`). It listens for
  `form.replied` and sends the answer with the engine's `steer` inbox delivery.
- An open question waits for its answer for up to a day, while the engine runs.
  Restarting OpenWork drops the wait; the card may stay but the answer then
  does not reach the chat.

## How to try it

1. Turn on `agentQuestions` for your organization.
2. Ask an agent for something with an open choice that it can partly do first,
   for example "draft a release note and ask me which version number to use".
3. The question appears while the agent keeps drafting. Answer it, and the
   agent finishes with your choice.

## Turning it off

The tool is withdrawn from the next prompt. Questions already open stay
answerable, and their answers still reach the chat. Nothing is stored.
