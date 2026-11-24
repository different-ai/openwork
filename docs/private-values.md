# Private values the agent never sees

A person keeps a password, a token, a one-time code or any other private
value in a password manager, or can print it with a command, or has it to
hand. When the agent needs that value, it never asks for it in chat and never
reads it. It names where the value comes from and where it goes, and OpenWork
does the rest on the person's computer after they approve a card in the chat.
The value never goes to the agent or to the model provider.

**Where a value comes from**

- **A command that prints it.** No password manager is built in and there is
  no list of supported ones. Anything that prints a value works: 1Password
  (`op read …`), Bitwarden (`bw get …`), the macOS keychain
  (`security find-generic-password … -w`), `pass show …`, a cloud CLI, or a
  script of your own.
- **The person pastes it** into a private field on the card, when nothing
  prints it.

**Where a value can go**

| Place | How the agent asks | Needs |
| --- | --- | --- |
| A field on a website | the `fill_from` action of the built-in browser | an `https://` page open in the built-in browser |
| A program | `use_private_values` with `run`: an environment variable, or a private temporary file | nothing else |
| One https request | `use_private_values` with `request`: `{{NAME}}` in a header or the body | nothing else |

Anything else is refused: a value cannot be written into a command's
arguments, a URL, a file that stays, or another tool's input.

- Feature key: `privateValues`
- Deployments: cloud and self-hosted, off by default
- Author: `benjaminshafii`
- Surface: OpenWork desktop chats. The values are fetched, used and replaced
  in the desktop app, so a task with no desktop app (cloud, an Automation run
  in the cloud) has neither tool.

This is separate from [secret handles](./browser/secret-handles.md), where the
person saves a value in OpenWork first. Both can be on at once.

## Filling a field on a website

1. On an `https://` page, with the feature on, the agent is told that fields
   can be filled from a command or from a value the person pastes.
2. The agent sends a `fill_from` browser action for each field. It names the
   field and exactly one of two things: a `command`, as a program and its
   arguments, or `ask`, a short name for the value ("Billing password"). It
   passes no value. A command that needs a locked password manager's key can
   also name the variable that key goes in; see
   [A password manager that is locked](#a-password-manager-that-is-locked).
3. OpenWork asks the person in the chat, once for the whole call. The card
   names the exact site and lists every field: for a command, the command in
   full and the kind of field it goes into; for a value asked for by name,
   that name and a private field to paste into.
4. On Run and fill (or Fill, when no command is involved), the desktop's main
   process runs each command just before its field is filled, so a one-time
   code is fresh. The command is started directly, with no shell, from the
   person's home folder, with no input.
5. What the command printed, less one final line break, or what the person
   pasted, is typed into the field. It is not written to disk, logs or the
   conversation.
6. The value is added to the same redaction set secret handles use. From then
   on, everything the browser tools return to the agent is checked for it, in
   the encodings a page could echo it in, and it is replaced before the agent
   reads it. A tab that received a value is not screenshotted again.

7. From the first value on, everything OpenWork sends to the model is checked
   the same way, whichever tool produced it: the instructions, every message
   in the conversation including older ones, tool inputs and tool results.
   A held value is replaced with `[secret]` before the request leaves. See
   [Everything sent to the model](#everything-sent-to-the-model).

"Always for this site in this chat" covers exactly what the card listed: the
same command, into the same kind of field, on the same site, in this
conversation. Any other command, field, site or conversation asks again. It is
kept in memory and gone when OpenWork quits. It is offered only when every
field on the card comes from a command and no command needs a key; a pasted
value or key is used once.

## Pasting a value

The agent asks for a value by name when no command prints it, or when the
command it tried is not installed. The person can also choose "Paste it
instead" on any command row, and that command is then not run.

- **The paste field is private.** What is pasted is masked, is not part of the
  conversation, and goes from the card to the desktop's main process, which
  holds it as a value to replace before doing anything else with it.
- **Fill waits.** The button stays off until every field that needs a pasted
  value has one.
- **The agent learns the outcome, not the value.** Its steps say `verified`
  or `failed` for each field, as with a command.
- **Keep for this chat.** A checkbox under each pasted value. When ticked, the
  value is kept in memory for this conversation, for this site and this name.
  The next time the agent asks for the same name on the same site, the card
  still appears, with one button and nothing to paste, and "Paste a different
  one" if it has changed. Nothing is kept unless the box is ticked, and
  nothing is kept past the conversation or past quitting OpenWork.
- **The agent never asks for the value in the chat itself.** A value typed
  into a message would go to the model. The agent is told to use `ask`
  instead, and the card is the only place to give the value.
- **From a phone or another remote approval, a paste cannot be given.** A card
  that needs a pasted value can only be answered in the desktop app. A card
  whose values are all already kept can be approved remotely.

A value the person pastes that cannot be typed (shorter than 4 characters,
longer than 4,096, or with a line break into a one-line field) stops the whole
call before anything is typed or run, with `pasted_unusable`. No command runs
in its place and no kept value is used instead.

## A password manager that is locked

Some password managers print nothing until they are given a session key.
Bitwarden reads one from `BW_SESSION`; 1Password service accounts read
`OP_SERVICE_ACCOUNT_TOKEN`. The agent can say so on a command:

```json
{ "type": "fill_from", "ref": "e7",
  "command": ["bw", "get", "password", "example.com"],
  "unlock": { "env": "BW_SESSION", "ask": "Bitwarden session key" } }
```

- **The card asks for the key once.** It gets its own row under the fields,
  with the name the agent gave, the program it is for and the variable it goes
  in, and a private field to paste into. Several commands that read the same
  key share one row. Run and fill stays off until the key is pasted.
- **The person gets the key themselves.** For Bitwarden, run `bw unlock --raw`
  in your own terminal and paste what it prints. OpenWork does not run an
  unlock command and never asks for a master password.
- **The key goes only to that program, for that run.** The desktop's main
  process sets the variable for the commands that named it and for nothing
  else. It is not written to disk, and it is held as a value to replace like
  any other, so it does not reach the agent or the model even if a tool
  prints it later.
- **Keep for this chat.** A kept key belongs to the program and the variable,
  not to a site, so the same password manager needs no second paste for
  another site in the same conversation. The card still appears before every
  run, with one button and "Paste a different one".
- **No "Always".** A call that uses a key is asked about every time.
- **Paste it instead still works.** If every command that reads the key is
  switched to a pasted value, the key row goes away and no key is needed.
- **Some variables are refused.** A name that decides which code runs (`PATH`,
  `HOME`, `NODE_OPTIONS`, anything starting `LD_` or `DYLD_`, and similar) is
  rejected before the person is asked.

A key that is too short, too long or more than one line stops the call before
anything runs, with `unlock_unusable`. A key the password manager no longer
accepts shows up as the command failing; the agent is told to send the same
action again so the person can paste a new key.

## Giving a private value to a program or one request

Some values are not for a page: a deploy script needs a token, or an API needs
a key in a header. For these the agent calls `use_private_values`. It is a
tool of its own and needs no browser: nothing has to be open, and it works in
a chat that never used one. It names up to six values, each by an UPPER_CASE name and a source (a `command` that
prints it, or `ask` for the person to paste it), and exactly one place they
go:

- **`run`**: a program and its arguments, started directly with no shell, in
  the chat's workspace folder. Each value is in an environment variable of
  that name. With `as: "file"`, the value is written to a private temporary
  file (readable only by you) that is deleted when the program ends, and the
  variable holds its path. Names that change how programs start, such as
  `PATH`, `HOME`, `NODE_OPTIONS`, `LD_*` and `DYLD_*`, are refused.
- **`request`**: one https request (`GET`, `POST`, `PUT`, `PATCH` or
  `DELETE`). Each value goes where `{{NAME}}` is written in a header or the
  body. Every value named must be placed, none may go in the URL, and
  redirects are not followed.

The same card asks first. It shows the exact command, or the method and the
address, and one row per value with where it goes ("As $DEPLOY_TOKEN", "In the
Authorization header"). Its buttons are Run or Send, Don't run or Don't send,
and "Always for this command in this chat" or "Always for this request in this
chat". "Always" covers only the same command, or the same method and address,
with the same sources.

The agent gets back what the program printed (up to 32 KB) or the response
(up to 64 KB), with every value replaced by `[secret]`, including its
URL-encoded, JSON-escaped and base64 forms. It never sees the values.

The agent has `use_private_values` only while the feature is on. The engine
asks the desktop app when a chat's engine starts, so after the feature is
turned on the tool appears in the next chat or after a restart, and with the
feature off the agent is never told the tool exists. The feature is checked
again on every call.

A request is ruled by its address like a page, by "Fill private values on
websites". A program is ruled by "Give private values to programs". Both are
in the member's "Recent fills" and the audit log as `run <command>` or
`<METHOD> <address>`.

### Sealing a secret the answer holds

A request can return a new secret, such as the access token from a token
endpoint. Without care, that token would reach the agent in the answer. The
agent lists it in `request.seal` instead, up to four entries:

- `name`: an UPPER_CASE name it is kept under, different from the request's
  own values.
- `from`: the dotted path of a string in the JSON answer, such as
  `access_token`, `data.token` or `items.0.key`.
- `for`: the one https origin it may later be sent to. It defaults to the
  request's own origin.

Each string found (4 to 4096 characters, one line) is taken out of the answer,
kept for this chat like a pasted value the person chose to keep, and replaced
by `[secret]` in the body and headers. The agent gets
`sealed: [{ name, for, kept }]`, never the value. If any seal is not found, or
the answer was cut at 64 KB, the whole body is withheld, since the secret may
be somewhere else in it.

To use it later, the agent writes a value `{ name, ask: "<SEALED NAME>" }` in a
request to the `for` origin. The card asks again and shows the row as kept;
nothing is pasted. A request to any other origin does not find it.

The card for a sealing request lists what it keeps, where from and where it
may go. It never offers "Always". It is refused before the card when the member
turned off keeping values for the chat, or when their organization blocks
private values on the `for` site.

There is deliberately no way to write a value to a file that stays. The
agent could read that file afterwards, so the value would no longer be
private.

## Everything sent to the model

A value OpenWork has fetched can come back by another road: the agent prints a
file that contains it, a connector returns it, the person types it. So the
check is not tied to any one tool.

- **On the way out.** Just before each request to the model, the engine hands
  the request's text to the desktop app, which replaces every value it holds
  and hands it back. This covers the whole conversation each time, so a
  message saved before the value was held is also clean when it is sent again.
- **In the saved conversation.** When a tool finishes, its result is checked
  before it is saved, so the value is not written into the conversation.
- **If the check cannot run.** Once a value has been held, a request the app
  could not check is not sent. It fails with "OpenWork could not check this
  for private values, so nothing was sent. Try again in a moment."

The values stay in the desktop's main process. The engine never holds them; it
sends text and gets text back, over the app's own authenticated local
connection. It works the same on both chat engines.

The check starts when the first value is held and the feature is on, and then
stays on until OpenWork quits, including for values saved as secret handles.
Before that, requests are not touched.

## The person's own settings

Settings › Computer use has a "Private values" section when the feature is on.

- **Get values from commands.** Off, a value that names a command is refused
  before any card, and the agent is told to ask for the value by name so the
  person pastes it.
- **Paste values into the card.** Off, a value asked for by name, or a key a
  command needs, is refused before any card.
- **Keep a pasted value for the chat.** Off, the card has no "Keep for this
  chat" box, and every value kept so far is forgotten.

All three start on. They are saved on this computer and apply to every
workspace and chat.

Below the switches, three lists show what is in force. None of them holds a
value.

- **Always used without asking:** each site, program or request the person
  chose Always for, with its command, and Remove to be asked again.
- **Kept for a chat:** each pasted value kept in memory, by its name and site,
  with Forget.
- **Recent fills:** the last 50 requests since OpenWork started, with the
  site, the kind of field, where the value came from, and how it ended:
  Filled, You said no, Blocked by your organization, or Turned off here.

Where the organization has decided, the switch is locked and says "Set by your
organization".

## What an admin controls

With the feature on, Members › Teams › Everyone › Browser (and each team's
Browser tab) has a "Private values" group of five permissions, below
"Websites". A team's setting applies to its
members; the usual rule holds that the last matching rule wins and a block
beats an allow of the same reach.

| Permission | Choices | What it does |
| --- | --- | --- |
| Fill private values on websites | Member decides, Ask first, Block, and lists of websites | Member decides is where it starts: the member approves each fill on a card and may choose "Always". Block stops every fill. With Block, "Always allow" lists the only websites where the member may fill. A blocked website is refused whatever the source. Ask first set here removes "Always" from the card, so the member approves every fill. |
| Get private values from commands | Allow, Block, and lists of commands | Block stops every command. With Block, "Always allow" lists the only commands that may run, for example `op read *`. A blocked command is refused even where the member had chosen Always. |
| Paste private values in the chat | On or off | Off stops pasting a value and pasting a key for a command, and forgets every value kept so far. |
| Let the agent run its private-value programs in its own terminal | On or off, starts off | Off refuses, in the agent's own terminal, every program the agent has named as the source of a private value. There is no list of names: any program named as a source counts. The same programs still work through the card. |
| Give private values to programs | Allow, Block, and lists of commands | Programs the agent runs with a private value in their environment or a private file (`use_private_values`). Block stops every such run. With Block, "Always allow" lists the only programs that may get values, for example `deploy *`. The member still approves every run on a card. A request to a website is ruled by "Fill private values on websites" instead. |

No setting lets a value be used without the member's card. An allowed website or
command means the member decides there.

A command rule is compared with the command as the card shows it, and again
with the folder of the program removed, so `bw *` covers
`/opt/homebrew/bin/bw get password example.com`. A rule written that way
accepts any program of that name. To allow one exact program, write its full
path.

A refusal happens before the person is asked. Nothing runs and nothing is
typed. The agent is told which rule refused it and for which team, and that no
other route gets around it. Rules reach a desktop within about a minute,
without a restart. If a desktop cannot read its organization's rules, it
refuses every fill until it can.

An older desktop that does not know these permissions is sent none of them.
It also has neither `fill_from` nor `use_private_values`, so nothing is left
unguarded.

### Keeping private-value programs out of the agent's own terminal

The agent decides which values are private: passwords, one-time codes, API
keys, tokens, account numbers, personal details, or anything the person would
not want it to read. Its instructions say to get every such value with
`fill_from`, never by running the command itself.

Every program the agent names in a `fill_from` command, or as the program a
pasted key unlocks, becomes fill-only. Naming it is enough, even when the
person declines the card. With the feature on, the agent's own terminal then
refuses that program unless an admin turns on "Let the agent run its
private-value programs in its own terminal". OpenWork never checks a list of
known names: a vault CLI with any name is covered once it has been used this
way. The program is refused wherever it appears in the line, for example inside
`$(...)`, after `&&` or behind `env` or `sh -c`, and with or without its
folder. The agent is told which team's setting refused it and to use
`fill_from` instead, where it never sees what the program prints.

The desktop keeps the fill-only programs, by file name only, in its private app
data, so a restart does not let one back in.

The switch alone decides: a Commands permission that allows a program does not
lift the refusal, and turning the switch on removes only these refusals.

Den sends this as one setting, not as command rules. Command rules of the
organization's own turn the OpenWork Sandbox off for the member; this setting
does not.

Limits:

- A program is fill-only only after it is named in a `fill_from`. Before then,
  if the agent runs it in its own terminal, the output reaches the model like
  any other. This is why the agent's instructions put the choice on it.
- A program copied under another name, or a script that calls it, is not
  recognized. A value it prints is still replaced once OpenWork holds that
  value.
- Commands that run inside the OpenWork Sandbox are not checked.
- A command whose program name is computed, such as `$TOOL get`, is refused
  only when a fill-only program's name appears as a word in the line.
- Both engines ask the desktop before each terminal command, so a change in Den
  applies without a restart. If the desktop cannot confirm its organization's
  rules, the command runs: the block is part of this feature, and a feature the
  desktop cannot confirm is off.
- Settings on the member's computer does not list the fill-only programs yet.

### Audit

Changes to these permissions are in the organization's audit log like every
other agent permission.

Each fill is reported to the organization's audit log as well: who, when, the
website, the field, where the value came from (a command, a paste or a value
kept for the chat), the program's name without its folder, and whether it was
filled, declined by the member or refused by an organization rule. The value
is never in the report. A fill the member's own switch turned off is not
reported. The events are `private_value.filled`,
`private_value.fill_declined` and `private_value.fill_refused`.

Reporting is best effort. The desktop tries three times and then gives up; a
fill is never held back because its report failed. A report retried after Den
recorded it but before the desktop heard back can appear twice. Fills made while the
desktop could not reach Den are only in the member's "Recent fills".

## What it protects, and what it does not

The value never appears in a tool call, a tool result, the conversation or a
log, so the model and its provider do not receive it.

The page does receive it. Unlike a secret handle, the real value is typed into
the field, so the site's own scripts can read it, as they could if the person
typed it. Approve a command only for a site you trust with that value.

Approving a command runs it as you. The agent chooses the command, and a web
page can try to talk the agent into choosing a harmful one. The card is the
check: read the command and the site before approving, and do not approve a
command you do not recognize.

A pasted value goes to the site named on the card. The agent chooses the name
shown next to the paste field, and a web page can try to talk the agent into
asking for something the page should not have. Read the site's address on the
card, not only the name of the value, before pasting.

## How to try it

1. Turn on `privateValues` for your organization in `/admin` ›
   organization › Features. The desktop picks it up within about a minute,
   without a restart.
2. Make sure the command works in your own terminal first, for example
   `op read "op://Private/Example/password"`. If your password manager needs
   a session key, such as Bitwarden's from `bw unlock --raw`, have it ready to
   paste.
3. In OpenWork desktop, open a conversation and its built-in browser, and go
   to the sign-in page of a site.
4. Ask the agent to sign in and tell it where the value is, for example
   "the password is in 1Password, item Example in the Private vault".
5. Check the command and the address on the card in the chat, then choose Run
   and fill. The field fills; the agent's steps show the field and an outcome,
   never the value.
6. To try pasting, ask the agent to sign in and say you will paste the
   password yourself. The card shows a private field; paste, optionally tick
   "Keep for this chat, in memory only", and choose Fill.
7. To try a program, with no browser open, ask the agent to run something
   that needs a token and tell it where the token is, for example "run
   `./deploy.sh`; it reads DEPLOY_TOKEN, which is in 1Password at
   op://Private/Deploy/token". The card shows the exact command and "As
   $DEPLOY_TOKEN"; choose Run. Start a new chat first if the feature was
   turned on after this one began.
8. To try a locked password manager, tell the agent which one it is, for
   example "the password is in Bitwarden, item example.com". The card lists
   the command and a row for the session key; paste the key, tick "Keep for
   this chat, in memory only" if you expect more sign-ins, and choose Run and
   fill.

## Turning it off

Turning the feature off, for the organization or with the kill switch, takes
effect within about a minute, without a restart:

- Pages are no longer described as fillable from a command or a pasted value.
- The `fill_from` action answers `values_unavailable`, runs nothing, and the
  agent hands the sign-in back to the person.
- `use_private_values` answers `values_unavailable` in a chat that already
  has it, and new chats are not given the tool.
- The feature is checked again before each command runs, not only when the
  person is asked.

Values already typed stay in the page. Redaction material for every value a
command printed or a person pasted stays in the main process until OpenWork
quits, so a later observation cannot expose an earlier echo. Nothing is stored
on disk, so there is nothing to migrate or clean up.

## What to watch

- `fill_from` steps report `verified` or `failed`. A failure names why, in
  OpenWork's own words: `command_not_found`, `command_timeout` (60 seconds;
  often a locked password manager), `command_empty`,
  `command_output_unusable`, `value_unusable`, `pasted_unusable`,
  `unlock_unusable`, `value_mismatch`, `credential_declined`,
  `site_not_secure`, `not_editable`.
- A refusal before the card names who decided: `values_blocked` (the website),
  `value_command_blocked` and `value_paste_blocked` are the organization's
  rules; `value_commands_off` and `value_paste_off` are the person's own
  switches in Settings.
- After `command_not_found`, the agent is told to try again with `ask`, so the
  person gets a second card with a paste field rather than a question in the
  chat.
- A command that exits with an error returns its exit code and the first line
  it wrote to its error stream, at most 200 characters, with known values
  replaced. Nothing it wrote to its output is returned.
- The value must never appear in a log, an error, a tool result, or the
  conversation. Treat any sighting as a security bug and turn the feature off.

## Known limits

- **Only `https://` sites.** A page on `http://`, including a local one, gets
  `site_not_secure`.
- **Up to 6 fields in one call**, from commands, pasted values or both. A
  command is at most 16 parts and 1,000 characters; a name for a pasted value
  is at most 80 characters. A value is 4 to 4,096 characters; a value with a
  line break goes only into a multi-line field.
- **A pasted value is not checked against the name.** OpenWork cannot tell
  whether what was pasted is the "Billing password" the card asked for.
- **A kept value is tied to the name the agent used.** If the agent asks for
  the same value under a different name, or on a different site, the person
  pastes again.
- **One command, one field.** A command runs once for each field it fills.
  One that makes a new value every time it runs, such as a password
  generator, gives "Password" and "Confirm password" two different values.
  When signing up, save the new password in the password manager first, then
  fill both fields by reading it.
- **No other tool takes a value.** A connector (MCP) tool, a website's own
  tool or the computer-use tools cannot be given a value by name. Use a
  website field, a program or a request.
- **No list of values to pick from.** The agent has to know, or be told, which
  command prints a value; OpenWork does not keep a list of sources.
- **No shell.** Pipes, variables and redirection do not work. Put them in a
  script and name the script by its absolute path.
- **A command that prints the value to its error stream and then fails** would
  put that line in front of the agent. Password managers do not do this; a
  script of your own should not either.
- **A code split across several boxes**, one character each, does not fill:
  the step reports `value_mismatch` and the agent hands off.
- **Short values over-redact.** A 6-digit code stays in the redaction set
  until OpenWork quits, so the same digits elsewhere on a page read as
  `[secret]` to the agent.
- **One key per command, from one variable.** A program that needs two
  variables set, or a key in a file or an argument, needs a script of your
  own. The agent has to know which variable the program reads.
- **A key is not checked before the command runs.** A wrong or expired key is
  found out when the command fails, and the person pastes again.
- **A key cannot be given from a phone or another remote approval** unless it
  is already kept for the chat.
- **Windows:** a program installed as a `.cmd` or `.bat` shim cannot be
  started without a shell. Name the real executable.
- **Only values OpenWork holds are replaced.** If the agent runs a password
  manager in its own terminal before OpenWork has fetched that value, the
  output goes to the model like any other. Once OpenWork holds the value, the
  same output is replaced. The same holds for a value the person types into a
  chat message before ever pasting it into a card. By default the agent's
  terminal refuses every program already named as a source; see "Keeping
  private-value programs out of the agent's own terminal".
- **"Always" and the lists in Settings last until OpenWork quits.** Nothing
  about a fill is written to disk except the three switches and the file names
  of fill-only programs.
- **A fill's report can be lost.** If the desktop cannot reach Den after
  three tries, the fill is only in the member's "Recent fills".
- **Pictures and files are not read.** A screenshot or an attached file that
  shows a value is sent as it is. The built-in browser does not screenshot a
  tab that received a value; other tools have no such rule.
- **Short values also change ordinary text.** If a held value is `1234`,
  every `1234` sent to the model, including in the person's own messages,
  reads as `[secret]` until OpenWork quits.
- **Older saved messages are not rewritten.** A message saved before the value
  was held keeps it on this computer; it is replaced each time it is sent.
- **After OpenWork restarts, nothing is held**, so nothing is replaced until a
  value is fetched again. Messages saved clean stay clean.
- **Conversation titles on the older chat engine** are written from the
  person's first message without this check.
- **A model's signed reasoning** that contained a value is changed by the
  replacement, and a provider may refuse it. Send the message again.
- **A runtime with no desktop app** (a cloud worker) holds no values, so its
  requests are not checked.
- **A program given a value can do anything with it.** It runs as you, and it
  could print the value in a form OpenWork does not recognize, send it
  elsewhere or save it. Approve only a program you recognize.
- **A response is read whole, then cut.** A response over 64 KB, or output
  over 32 KB, reaches the agent cut off. A request has no streaming.
- **No file that stays.** See "Giving a private value to a program or one
  request".
- Cloud: not available. There is no desktop app to fetch a value or show the
  card.
