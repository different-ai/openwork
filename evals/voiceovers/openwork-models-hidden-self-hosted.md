# micx-models-hidden-self-hosted — Self-hosted desktops never see Micx Models upsells

This proof runs the real desktop app in a disposable sandbox. On the hosted
Micx Cloud control plane the Micx Models offer is visible on every
surface; after pointing the app at a self-hosted organization server, every one
of those surfaces disappears, and clearing the configuration brings them back.

1. On Micx Cloud, Alex opens the model picker in the composer. The Micx Models group sits at the top of the list, pitching hosted frontier models.

2. In Settings, the AI page shows the Micx Models banner with a Subscribe button.

3. When Alex sets up a new workspace, the provider choice step opens and offers Use Micx Models next to bring-your-own-key and the free model.

4. Alex goes to Settings Advanced and points the desktop at the company's own self-hosted organization server. The app saves the URL and reloads against the new control plane.

5. Back in the session, the Micx Models startup pitch never appears, and the AI settings page no longer mentions Micx Models at all — self-hosted deployments only see real providers.

6. The model picker now lists only connected providers. The Micx Models group is gone.

7. Setting up another workspace on the self-hosted server still opens the provider step, but it only offers bring-your-own-key and the free model — no Micx Models option.

8. Alex clears the server configuration to return to Micx Cloud. After a reload, the Micx Models subscribe banner is back, confirming hosted deployments are unchanged.
