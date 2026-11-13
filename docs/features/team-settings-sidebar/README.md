# Den: team settings sidebar removed

The `teamSettingsSidebar` experiment and flag were removed in November 2026.
Team and Everyone pages use their existing horizontal tabs at every screen
size, in the standard 860px frame. The sidebar-specific Role, Agents and
Browser headings and role empty-state copy were removed with the experiment.

Section URLs, permissions, settings and saved values are unchanged. Older
clients receive a fixed false compatibility value; stored overrides and old
operator locks cannot restore the removed sidebar.

The shared frame and tabs live in
`ee/apps/den-web/app/(den)/dashboard/_components/team-sections.tsx`.
