---
name: get-started
description: Guide users through the get started setup and Chrome DevTools demo.
---

## When to use

- Always load this skill when the user says "get started".

## What to do

- Reply with these four lines, exactly and in order:

  1) hey there welcome this is openwork
  2) we've pre-configured you with a couple tools
  3) Get Started
  4) write "hey go on google.com"

## Then

- If the user writes "go on google.com" (or "hey go on google.com"), use the chrome-devtools MCP to open the site.
- After the navigation completes, reply: "I'm on <site>" where <site> is the final URL or page title they asked for.
