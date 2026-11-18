# Model setting continuity

This fix is independent of #4629. Discovery, upgrade and free-allowance
policies are excluded. This change makes the supplied model
settings behave consistently in the composer, full picker and Automation editor.

- Provider Default is an actual `null` choice. It remains selectable, correctly
  checked and reachable by forward/backward effort cycling.
- Options come from the supplied runtime model variants, including custom variant
  keys. No new client-owned model snapshot, whitelist or price table is introduced.
- Compact effort stays unavailable when the model advertises no variants and has
  no saved effort. A stale saved value still exposes Default so it can be cleared.
- Displaying a saved same-model choice never normalizes or overwrites it merely
  because metadata is missing or the value is no longer listed. The UI explains
  that uncertainty and offers Default or a currently supplied choice.
- Explicitly switching models carries only a setting offered by the target;
  otherwise it chooses Default. Keyboard and compact favorite cycling agree.
- The full picker exposes working settings controls for its current model.
  Automation editing preserves same-model choices and resets on model changes.
  Editing effort does not replace an unrelated global default model, submit a
  draft, execute a task, purchase access or change credentials.

Provider acceptance of an unlisted saved value is unknown. This is state/UI
continuity, not a new gateway enforcement contract or a guarantee that the engine
or provider can execute an unsupported variant.

The existing catalog JSON, model-maintenance commands and provider materialization
paths remain unchanged. #4513 owns scheduled mirror freshness. Do not replace
server-delivered catalog data with compiled client maps as part of this fix.

Supporting checks live in the existing model-behavior, model-picker, Automation
options/editor and composer-controls tests. The existing
`composer-model-picker-no-subscribe-promo` journey includes explicit Default
selection and full-picker settings editing. Component tests cover effort round
trips and do not replace that journey.
Automation settings have component coverage; full Automation runtime dispatch is
outside this change.

This fix targets dev directly without the former parent stack. Prior stack-head
runtime evidence does not validate this adapted head; fresh exact-head proof is
required. Budgets, billing, backend catalog delivery and transport are not changed.
