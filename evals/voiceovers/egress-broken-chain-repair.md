# egress-broken-chain-repair — Leaf-only certificate chains are repaired and diagnosed

1. The lab serves a leaf-only chain with the root trusted. Plain Node fails with the first-certificate error, OpenWork's runtime AIA repair adds the missing intermediate and succeeds, disabling repair fails again, and the shipped diagnostics name the missing-chain fault.
