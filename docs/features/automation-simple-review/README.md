# Simpler Automation review in chat

`automationSimpleReview` is off by default on Cloud and self-hosted deployments.

The card puts the task, schedule, and execution location first. Expand **Details** for the model, workspace, or to change where it runs. The full task instructions stay visible so someone can see what they are approving. **Create and turn on** starts the schedule; the created card opens that specific Automation. Scheduling and permissions are unchanged.

Try it in an isolated workspace with the feature on: ask for a daily summary, check the schedule and location, expand **Details**, and create it. In a turn that has more steps after the proposal, create it before the turn finishes. The card should stay outside the activity fold and retain its created state. Confirm **Open Automation** opens the item just created. Check blocked and signed-out states as well. Turning the feature off reverts to the original card layout without bringing back the activity-fold remount.
