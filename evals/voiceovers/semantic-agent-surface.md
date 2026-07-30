# semantic-agent-surface — OpenWork exposes one understandable surface to people and agents

1. OpenWork shows three conversation tabs with two sessions in split view. I ask, “What am I looking at?” and chat identifies the workspace, open tabs, both visible sessions, focused pane, sidebar, side panel, and settings state.

2. I ask, “Take me to the previous session.” OpenWork resolves the session from backend data and reuses its existing tab or split pane instead of opening a duplicate.

3. I ask, “What did I say in the previous session?” OpenWork reads the transcript without changing the visible session or stealing focus.

4. I open AI settings and collapse the sidebar. Chat still understands the retained workbench and current settings panel, despite those elements not all being visible simultaneously.

5. A known remote skill remains available directly from injected skill guidance, while an unknown remote capability follows search then exact execution. Local extensions follow the same descriptor pattern.

6. I ask what actions are currently available. OpenWork returns understandable actions with their effects—read data, change UI, change durable state, or require user interaction.
