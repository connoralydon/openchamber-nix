# Easter eggs

## Ownership

This module owns the small jokes the app tells at ordinary moments: the rotating new-session heading, the line under "Working tree clean", the toast for a late-night or Friday-evening push, the toast for a commit that deletes clearly more than it adds, and the calendar that switches some of them on Halloween and New Year. It picks lines; the components that show them (`components/chat/useDraftHeading.ts`, `GitEmptyState`, `GitView`) decide where. The celebration overlay lives in `components/ui/FireworksAnimation.tsx` and `fireworksShows.ts`, which read the same calendar for Halloween ghosts and the New Year palette. The About dialog's seven-tap logo animation is `components/ui/LevitatingLogo.tsx`.

## Invariants

- Every line lives in `copy/<locale>.ts`, one file per UI locale, typed by `copy/types.ts`. `lines.test.ts` fails when a locale is missing or a line lost the placeholder the code fills (`{project}`, `{time}`, `{count}`).
- A caller falls back to its ordinary translated text while the locale's copy loads and wherever a picker returns null. No one sees another language's joke, and nothing waits on this module.
- The clock is the viewer's local clock, read at the moment the line is picked.
- A line stays put while it is on screen: a draft keeps its heading while open, the clean state keeps its line while shown.
- Enterprise mode shows all of this. The jokes are part of the product, not a consumer extra.

## Decisions

### Why separate copy files and not the i18n dictionaries

The dictionaries need the same keys in every locale, and the jokes do not translate one to one: a locale writes its own lines, may have more or fewer of them, and may skip one that does not work in that language (`push.fridayEvening` is empty in Arabic and Hebrew, where Friday evening already is the weekend). Lists of different lengths per locale do not fit flat keys, and one file per locale keeps every joke of a language in one place to read and edit.

### Why a net-deletion threshold

A commit that removes one line more than it adds is every other commit. The line shows from `NET_DELETION_THRESHOLD` lines net, so it stays a surprise.

### Why the draft heading is picked per draft id

The welcome heading and the composer heading render the same draft in two components. Keying the pick on the draft id makes both show the same line, keeps it while the draft is open, and moves to the next line with the next draft. A random seed per app run keeps the first draft after launch from always opening on the same line.
