# Pick effort from the composer (`effortQuickPick`)

- **Feature key:** `effortQuickPick`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

Changing a model's effort used to take three steps: open the model list, press
**Effort** at the bottom, then choose a level. The composer also hid the effort
while it was the model's default, so there was nothing to click.

With the feature on:

- The composer always shows the effort after the model name, including the
  default: `Haiku 5.5 · Default`, `Haiku 5.5 · Medium`.
- The effort is its own button. Clicking it opens the effort list directly,
  with the current level focused. Clicking the model name still opens the
  model list.
- Choosing a level applies it and closes the list. **Up** and **Down** move
  between levels, **Back to models** opens the full model list.
- Models that have no effort setting, or whose effort OpenWork or a Smart
  Router manages, show only the model name, as before.

With the feature off, the composer has one button that opens the model list
and names the effort only when it is not the default.

## How to try it

Turn `effortQuickPick` on for an organization in `/admin` › Features, open a
chat with a model that offers effort levels, and click the effort beside the
model name under the message box.
