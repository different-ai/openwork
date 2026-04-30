---
name: command-creator
description: Create OpenCode custom commands for repeatable tasks.
---

## Quick Usage (Already Configured)

### Create a new command file
```bash
mkdir -p .opencode/commands
```

Create `.opencode/commands/<name>.md` with frontmatter and a prompt template.

### Command file example
```
---
description: Run tests with coverage
agent: build
model: gpt-5.2-codex
---

Run the full test suite with coverage report and show any failures.
Focus on the failing tests and suggest fixes.
```

## Prompt config essentials

- Use `$ARGUMENTS` for all arguments, or `$1`, `$2`, `$3` for positional args.
- Use `!\`command\`` to inject shell output into the prompt.
- Use `@path/to/file` to include file contents in the prompt.

## Notes from OpenCode docs

- Command files live in `.opencode/commands/` (project) or `~/.config/opencode/commands/` (global).
- The markdown filename becomes the command name (e.g., `test.md` → `/test`).
- JSON config also supports commands in `opencode.json` under `command`.
- Custom commands can override built-ins like `/init`, `/undo`, `/redo`, `/share`, `/help`.

## Reference

Follow the official OpenCode command docs: https://opencode.ai/docs/commands/
Use the docs as the escape hatch when unsure.

## Docs snapshot

Skip to content
OpenCode

Search
⌘
K
Intro
Config
Providers
Network
Enterprise
Troubleshooting
Migrating to 1.0
TUI
CLI
Web
IDE
Zen
Share
GitHub
GitLab
Tools
Rules
Agents
Models
Themes
Keybinds
Commands
Formatters
Permissions
LSP Servers
MCP servers
ACP Support
Agent Skills
Custom Tools
SDK
Server
Plugins
Ecosystem
On this page
Overview
Create command files
Configure
JSON
Markdown
Prompt config
Arguments
Shell output
File references
Options
Template
Description
Agent
Subtask
Model
Built-in
Commands
Create custom commands for repetitive tasks.

Custom commands let you specify a prompt you want to run when that command is executed in the TUI.

/my-command

Custom commands are in addition to the built-in commands like /init, /undo, /redo, /share, /help. Learn more.

Create command files
Create markdown files in the commands/ directory to define custom commands.

Create .opencode/commands/test.md:

.opencode/commands/test.md
---
description: Run tests with coverage
agent: build
model: anthropic/claude-3-sonnet-20241022
---

Run the full test suite with coverage report and show any failures.
Focus on the failing tests and suggest fixes.

The frontmatter defines command properties. The content becomes the template.

Use the command by typing / followed by the command name.

"/test"

Configure
You can add custom commands through the OpenCode config or by creating markdown files in the commands/ directory.

JSON
Use the command option in your OpenCode config:

opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "command": {
    // This becomes the name of the command
    "test": {
      // This is the prompt that will be sent to the LLM
      "template": "Run the full test suite with coverage report and show any failures.\nFocus on the failing tests and suggest fixes.",
      // This is shown as the description in the TUI
      "description": "Run tests with coverage",
      "agent": "build",
      "model": "anthropic/claude-3-5-sonnet-20241022"
    }
  }
}

Now you can run this command in the TUI:

/test

Markdown
You can also define commands using markdown files. Place them in:

Global: ~/.config/opencode/commands/
Per-project: .opencode/commands/
~/.config/opencode/commands/test.md
---
description: Run tests with coverage
agent: build
model: anthropic/claude-3-5-sonnet-20241022
---

Run the full test suite with coverage report and show any failures.
Focus on the failing tests and suggest fixes.

The markdown file name becomes the command name. For example, test.md lets you run:

/test

Prompt config
The prompts for the custom commands support several special placeholders and syntax.

Arguments
Pass arguments to commands using the $ARGUMENTS placeholder.

.opencode/commands/component.md
---
description: Create a new component
---

Create a new React component named $ARGUMENTS with TypeScript support.
Include proper typing and basic structure.

Run the command with arguments:

/component Button

And $ARGUMENTS will be replaced with Button.

You can also access individual arguments using positional parameters:

$1 - First argument
$2 - Second argument
$3 - Third argument
And so on…
For example:

.opencode/commands/create-file.md
---
description: Create a new file with content
---

Create a file named $1 in the directory $2
with the following content: $3

Run the command:

/create-file config.json src "{ \"key\": \"value\" }"

This replaces:

$1 with config.json
$2 with src
$3 with { "key": "value" }
Shell output
Use !command to inject bash command output into your prompt.

For example, to create a custom command that analyzes test coverage:

.opencode/commands/analyze-coverage.md
---
description: Analyze test coverage
---

Here are the current test results:
!`npm test`

Based on these results, suggest improvements to increase coverage.

Or to review recent changes:

.opencode/commands/review-changes.md
---
description: Review recent changes
---

Recent git commits:
!`git log --oneline -10`

Review these changes and suggest any improvements.

Commands run in your project’s root directory and theutput becomes part of the prompt.

File references
Include files in your command using @ followed by the filename.

.opencode/commands/review-component.md
---
description: Review component
---

Review the component in @src/components/Button.tsx.
Check for performance issues and suggest improvements.

The file content gets included in the prompt automatically.

Options
Let’s look at the configuration options in detail.

Template
The template option defines the prompt that will be sent to the LLM when the command is executed.

opencode.json
{
  "command": {
    "test": {
      "template": "Run the full test suite with coverage report and show any failures.\nFocus on the failing tests and suggest fixes."
    }
  }
}

This is a required config option.

Description
Use the description option to provide a brief description of what the command does.

opencode.json
{
  "command": {
    "test": {
      "description": "Run tests with coverage"
    }
  }
}

This is shown as the description in the TUI when you type ithe command.

Agent
Use the agent config to optionally specify which agent should execute this command. If this is a subagent the command will trigger a subagent invocation by default. To disable this behavior, set subtask to false.

opencode.json
{
  "command": {
    "review": {
      "agent": "plan"
    }
  }
}

This is an optional config option. If not specified, defaults to your current agent.

Subtask
Use the subtask boolean to force the command to trigger a subagent invocation. This is useful if you want the command to not pollute your primary context and will force the agent to act as a subagent, even if mode is set to primary on the agent configuration.

opencode.json
{
  "command": {
    "analyze": {
      "subtask": true
    }
  }
}

This is an optional config option.

Model
Use the model config to override the default model for this command.

opencode.json
{
  "command": {
    "analyze": {
      "model": "anthropic/claude-3-5-sonnet-20241022"
    }
  }
}

This is an optional config option.

Built-in
opencode includes several built-in commands like /init, /undo, /redo, /share, /help; learn more.

Note

Custom commands can override built-in commands.

If you define a custom command with the same name, it will override the built-in command.

Edit this page
Find a bug? Open an issue
Join our Discord community
© Anomaly

Jan 24, 2026
