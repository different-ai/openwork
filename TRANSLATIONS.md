# Help Translate OpenWork

We are actively looking for contributors to translate OpenWork to your own native language.

## README translations

Translated README variants live in `translated_readmes/`, so adding a new language only touches the index there plus the supported languages list in the root `README.md`.

If you want to add a new README language:

1. Copy `README.md` to a new file like `translated_readmes/README_<LANG>.md`.
2. Translate the content.
3. Add your new language link to `translated_readmes/README.md`.
4. Add your language name to the supported languages list at the bottom of `README.md`.
5. Open a PR.

## App UI translations (i18n)

You can also help translate the app UI via:

- `packages/app/src/i18n/`

Currently available app UI locales: English (`en`), Japanese (`ja`), Simplified Chinese (`zh`), Vietnamese (`vi`), Brazilian Portuguese (`pt-BR`).

Locale files live in `packages/app/src/i18n/locales/`.

If you are unsure where to start, open an issue and mention the language you want to contribute.
