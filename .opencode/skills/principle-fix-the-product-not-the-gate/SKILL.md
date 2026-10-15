---
name: principle-fix-the-product-not-the-gate
description: "Apply when a spec, rubric, design note, check, or claim disagrees with the product. Fix the product, or change the claim explicitly in its own reviewed step; never bend the gate to go green."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Fix the Product, Not the Gate

A failing check is information about the product until shown otherwise.

**Why:** Editing the rubric, loosening the assertion, or rewording the claim in the same PR that trips it turns the gate into decoration.

- Fix design notes in product code, never in the spec or `evals/design-review/rubric.md`.
- If product and claim diverge, change one on purpose and say which. Never smuggle the answer into the prompt or the fixture.
- Fix the shared component the hook points at, not each screen.
- A judgment you keep against a check gets one line of reasoning in the PR, not an edit to the check.
