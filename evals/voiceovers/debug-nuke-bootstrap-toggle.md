# debug-nuke-bootstrap-toggle — Choose whether organization bootstrap survives

1. The fresh-start dialog keeps the organization bootstrap by default. The exact desktop-bootstrap.json path appears under Will survive, so the safe existing behavior is explicit before anything destructive can run.

2. One switch changes the plan to a complete local reset. The bootstrap path moves into Will delete and disappears from Will survive, while the typed NUKE confirmation remains required.
