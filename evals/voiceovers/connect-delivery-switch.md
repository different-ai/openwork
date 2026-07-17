# connect-delivery-switch — retired switch now proves Connect-only delivery

Cast is Alex, the Acme Robotics admin, using the OpenWork desktop app against the local Den stack. This older switch proof is now retired into the new contract: toggling Acme's Connect capability must not bring back desktop imports for Den marketplace plugins.

1. With Connect turned off, Alex opens the organization Marketplace. The seeded plugin is already Active · runs in cloud, and there is no Add, Install, or Update button.

2. The platform admin enables Acme's Connect capability. Back in Extensions, the Marketplace tab still exists for local/built-in affordances, but the seeded organization plugin is absent.

3. Alex opens Connect. In the active Connect state, From your organization lists the same seeded plugin as ready, with no install button because delivery happens through the cloud rail.

4. The platform admin turns Connect back off. The organization Marketplace still shows the seeded plugin as cloud-delivered only, proving the old reversible desktop-install path is gone.
