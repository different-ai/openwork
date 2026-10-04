# Move from Claude Cowork to OpenWork

You are an agent (in Claude Cowork, Claude Code, Codex, or OpenWork) helping a
person move their Claude plugins and skills into their OpenWork organization.

Goal: find what they use on this computer, show them what will move, import
what they choose, and tell them exactly what is left for them to do. Everything
here is safe to run again: imported plugins update in place and nothing is
duplicated.

> Use the `openwork-bootstrap` command for every step below.

## 1. Install the CLI

If `openwork-bootstrap --version` already works, skip this step.

```bash
curl -fsSLo /tmp/openwork-install.sh https://openworklabs.com/install.sh
less /tmp/openwork-install.sh
sh /tmp/openwork-install.sh
```

Do not pipe remote scripts straight into a shell. The script installs one
dependency-free Node file into `$HOME/.local/bin`.

## 2. Sign in

```bash
openwork-bootstrap login --json
```

It prints a link and a code. Give both to the person; they approve it in the
browser. Importing plugins for the organization needs an owner or admin
account. If they belong to several organizations, ask which one and pass
`--org <id>` to the commands below.

## 3. See what is on this computer

```bash
openwork-bootstrap migrate scan --json
```

This only reads names and paths. It finds:

- `marketplaces`: plugin marketplaces added in Cowork or Claude Code (for
  example `anthropics/knowledge-work-plugins`);
- `skills`: skills the person wrote themselves in Cowork (Anthropic's built-in
  skills are left out);
- `unsupported`: marketplaces that are not public GitHub repositories. Tell the
  person these cannot be imported automatically.

## 4. Preview the move

```bash
openwork-bootstrap migrate plan --json
```

Nothing changes yet. For each marketplace it lists every plugin with its skills,
the connectors it can use, and anything the person must set up themselves. Show
this as a short list and ask which plugins they actually use. Cowork does not
record which plugins were turned on, so do not guess; Claude Code's installed
plugins are listed under `installedLocally`.

To migrate a marketplace that the scan did not find, pass
`--source https://github.com/<owner>/<repo>`.

## 5. Import

```bash
openwork-bootstrap migrate apply --plugin <name>,<name> --json
```

- Plugins become available to the whole organization. Add `--private` to keep
  them to the person until they share them.
- The person's own Cowork skills are uploaded as private skills only they can
  use. Say so before running; add `--no-skills` if they prefer not to.
- Use `--all` only if the person asks for every plugin.

## 6. Report

From the `apply` output, tell the person:

- for each plugin: `created` or `updated`, how many skills and connectors;
- their own skills: `created`, `updated`, or `unchanged`;
- `nextSteps`: connectors the plugin leaves for them to choose (for example
  Gmail or Google Calendar). They connect these in OpenWork under Connections.

Connectors that came with a plugin are optional. Skills work right away; each
person connects the services they use, and a skill says which ones help.

If the OpenWork MCP is connected to you, confirm one skill works by calling
`get_skill` with `<plugin>/<skill>` (for example `productivity/start`).

## 7. Run it again later

Run `migrate apply` with the same plugins whenever the person wants to pick up
changes from the marketplace or from their own skills. Unchanged items are
reported as unchanged.

## Constraints

- Do not print tokens or credentials.
- Do not upload the person's own skills without telling them first.
- Only public GitHub marketplaces can be imported. Private repositories go
  through the GitHub connector in OpenWork Cloud.
- Report what moved and what did not; do not claim a connector is connected.
