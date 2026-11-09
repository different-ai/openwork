# Workbot: quiet calendar

Feature: `workbotQuietCalendar` · Cloud and self-hosted · Default **off** · Author: @benjaminshafii.

Workbot's Calendar for someone with many automations. Today each run is a chip that shares the day's width with meetings, so a busy day shows dozens of one-letter chips ("T.", "A.") and nothing reads.

## What changes

- **Meetings own the grid.** Only meetings share a day's width; they are soft filled blocks with no outline. Past meetings are lighter, the current one darker.
- **Runs are dots.** Each automation run is a small dot at its time on the left edge of the day: filled grey when done, a ring when it is still to come. Runs a few minutes apart with the same status share a dot. A failed run is a small red dot, not a banner. Hover or focus a dot to read it; click it for that automation's panel.
- **Counts in the day header,** in plain text: "15 runs", "1 failed, 15 done", "3 done, 5 to go", "1 won't run, 7 planned". Working-location all-day events (Office, Home) sit in the header instead of taking a row.
- **The panel opens on demand.** The toolbar's "2 need you · 80 runs" opens *Workbot this week*: what needs the person (failed runs with Try again, automations that won't run until fixed), what runs next, and each automation's week as a row of dots. Nothing is selected when the page opens. The Automations/Meetings checkboxes are gone.
- **Agenda.** The view switch is Agenda / Week / Month. The Agenda view, and any window narrower than 760px (phones, or the calendar beside a preview), is a list: today onward, meetings with the Workbot runs that were about them (`triggerContext.eventId`) inside the meeting, other runs as quiet rows, finished routine runs collapsed to one line.
- **Month** cells show meetings only, then one line for the day's runs.
- The meeting panel lists "Workbot for this meeting".

## Try it

Turn the flag on for a test organization in `/admin` → organization → Features. Locally:
`?calendar=1&quietCalendar=1` on the chat-screen fixture (it serves a week of meetings and runs around today from `test-fixtures/calendar-fixture.ts`). Screenshots are in the PR.

## Turning it off

The calendar goes back to the chip grid with layer checkboxes. It reads the same automations, runs and meetings either way; nothing is stored.
