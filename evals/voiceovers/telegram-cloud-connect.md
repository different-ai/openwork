# telegram-cloud-connect — A private Telegram chat can securely reach one OpenWork Cloud worker

This first release covers BotFather-created bots and paired private text chats. Managed Bots, Secretary Mode, groups, and inbound media remain follow-up work.

1. I open Connections, choose Telegram, add my bot token, and select the OpenWork worker that should answer. OpenWork validates the bot and clearly explains that this first version accepts paired private chats only.

2. The connection turns green with the bot's username and a healthy delivery status. OpenWork gives me a one-time pairing link, so I never have to copy a chat ID or expose the bot token.

3. I open the link in Telegram and press Start. Telegram confirms that this private conversation is now connected to the worker I selected.

4. I ask the bot to summarize the launch notes in my OpenWork workspace. The selected worker runs the task and returns its final answer in the same Telegram conversation.

5. Back in OpenWork, I ask the agent to send an update to my paired Telegram chat. The message arrives under the same bot, proving the connection works in both directions.

6. I disconnect Telegram from OpenWork. The connection reports that delivery is disabled, and later messages can no longer reach the worker.
