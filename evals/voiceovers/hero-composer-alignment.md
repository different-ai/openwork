# hero-composer-alignment — The new-task composer lines up with everything under it

OpenWork now opens on the new-task screen, and that screen reuses the real chat
composer. The composer used to be inset by the padding it needs when it is
docked at the bottom of a chat, so it rendered visibly narrower than the starter
cards underneath it and the column looked crooked. This demo walks the screen a
user actually sees and measures the edges.

1. OpenWork opens on the new-task screen: "What do you need done?", the real composer with its agent, model and effort controls, and the starter cards sitting underneath it.

2. Picking a starter card drops its prompt straight into the composer, and the column holds true: the composer card begins and ends on exactly the same lines as the cards below it, instead of sitting as a narrow box above wider cards.

3. Starting a task hands the same composer to the chat, where it still docks to the bottom with its centred, cushioned chat look. Only the new-task screen changed.
