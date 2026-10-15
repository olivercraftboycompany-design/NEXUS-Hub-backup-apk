# NEXUS Hub

One dashboard for all of Oliver's NEXUS apps: Bibley, nortest, NEXUS Calendar, NEXUS News, Ultimate Weather and Apologetics101. It shows stats and controls each app.

Live: https://olivercraftboycompany-design.github.io/NEXUS-Hub/

All the apps share one site (olivercraftboycompany-design.github.io), so the Hub can read and change their saved data on the same phone/browser.

## Controls (controls.js)
- **nortest**: a remote that uses the player's own text remote (ntfy topic `nortest-7013d8b424a21d78`; status replies come on `-status`). Play/pause, prev/next, volume, shuffle and repeat. Works with the player open on any device.
- **Calendar**: quick-add an event or homework into `nxcal_v1` (the app's own event shape), and tick homework done/undone (`done["<id>@<date>"]`). An open Calendar tab updates live through the storage event.
- **Bibley**: "Mark Day N read" does the same thing as Bibley's own Mark read: it updates `bibley_plan_v1`, `bibley_read_v1` and `bibley_activity_v1`. There's also Continue reading (`#continue`) and Verse of the Day Copy/Share.
- **News**: a category picker for the headlines (Hub-only setting) and un-save a story (`nxnews_saved_v1`).
- **Weather**: switch city (`nx_last`, using the same lookups as the app), pick one of the app's saved spots, and °F/°C (`nx_unit`). Alerts and live updates deep-link to the app's `#notify`.
- **Apologetics101**: Continue reading plus links to each article, Answers and Quiz.

## Safety
- Before the first change to an app (per Hub session) and before any restore, a snapshot goes into the Hub's own IndexedDB `nxhub` → `nxhub_snapshots` (the last 5 per app). To use one: ⚙️ → Restore a snapshot.
- Every change has Undo.
- Push subscriptions (`nxcal_push`, `nx_push`) are never copied or changed. IndexedDB versions are never bumped, and the Hub never creates the `nortest` database.

## Hub-wide
- Quick actions: Music, + Event, ✓ Reading, Backup.
- ⚙️ → Cards: reorder and hide cards (`nxhub_layout`).
- ⚙️ → Back up everything: one JSON file with every app's saved data, plus nortest's library list, playlists and settings (no audio). Restore from file shows a preview first. For nortest, a restore brings back settings, play counts and playlists (using only the songs already on the phone).

The Hub's own keys start with `nxhub_`.
