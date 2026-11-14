# Ollama under AI Providers (`ollamaInAiProviders`)

- **Feature key:** `ollamaInAiProviders`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @OmarMcAdam

## What people get

Off, desktop Settings lists **Ollama** as its own page in the Global group of
the sidebar, next to **AI Providers**.

On, the sidebar (and the compact section menu) no longer lists Ollama. Ollama
is a way to get models, so it lives with the other providers: the bottom of
**AI Providers** has a secondary **Use Ollama** button that opens the same
Ollama page as before (`/settings/ollama`). While the Ollama page is open, the
sidebar highlights **AI Providers**.

The Ollama page itself is unchanged: install, sync and manage local models
work exactly as before. The command palette still finds the Ollama page.

When the organization turns off local models (`allowLocalModels`), the
**Use Ollama** button is not shown, and opening `/settings/ollama` directly
still shows the existing "blocked by your organization" notice.

## Off

Turning it off brings back the Ollama sidebar entry and removes the button. It
is safe to turn off at any moment: nothing is stored, and Ollama models a
person already set up keep working, since only navigation changes.

## Try it

Turn the feature on for an organization, open desktop Settings, check the
sidebar has no Ollama entry, open **AI Providers**, scroll to the bottom and
click **Use Ollama**.
