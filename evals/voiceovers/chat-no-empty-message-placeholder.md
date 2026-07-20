# chat-no-empty-message-placeholder — Sending a prompt never leaves "Empty message" debris in the chat

Before this fix, triggering a prompt could flash a literal "Empty message" placeholder in the transcript — and when a run ended before the assistant produced anything, the placeholder stuck around forever. This proof drives the real desktop app: Alex sends a prompt, watches the whole send-to-response window, and the transcript stays clean throughout.

1. Alex opens OpenWork on a fresh task, ready to chat.

2. Alex types a short prompt and sends it. While the app hands the prompt to the agent — the exact window where the placeholder used to flash — the transcript shows Alex's bubble and never the words "Empty message".

3. The agent's reply streams in and completes. The finished transcript holds just the conversation — still no placeholder text anywhere, and the placeholder is gone from the app for good.
