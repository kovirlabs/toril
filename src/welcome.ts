// The two documents Toril opens when there is nothing else to show
// (ROADMAP Movement I.5).
//
// Their own module rather than constants in `main.ts` for one concrete reason:
// FIRST_RUN claims, in its own text, that Toril does not rewrite your files —
// so it is itself a round-trip fixture, and `tests/roundtrip.test.ts` imports
// it from here to check that saving it is a no-op diff. A welcome note that
// reformatted itself on first save would refute its own second paragraph.

// Two different documents for two different situations, which the old single
// stub conflated.
//
// FIRST_RUN is shown once, to someone who has never opened Toril. It is written
// in the canonical form the serializer emits, so saving it is a no-op diff —
// the welcome note demonstrating the round-trip guarantee rather than
// contradicting it on its first save.
//
// Two details here are load-bearing and were found by the gate, not by reading:
// the table pipes are **padded** to the column width (remark's canonical form —
// `| --- |` gets rewritten), and the pane shortcuts are code spans rather than
// bold because `**Ctrl+\**` ends a strong span with a backslash, which escapes
// the closing marker and mangles the text. Neither is a style preference; edit
// this copy and rerun `tests/roundtrip.test.ts`.
//
// EMPTY is for every later launch with nothing to restore. Someone who has used
// Toril before does not need the tour again; they need a blank page.
export const FIRST_RUN = `# Welcome to Toril

This is a real document — edit it, or start over with **Ctrl+N**.

## Your notes stay yours

Toril reads and writes plain \`.md\` files in ordinary folders. There is no
database, no proprietary container, and nothing to export later. Point it at an
Obsidian vault and both apps can use it.

- **Ctrl+Shift+O** — open a folder of notes
- **Ctrl+O** — open a single file
- **Ctrl+S** — save · **Ctrl+F** — find and replace
- \`Ctrl+\\\` — files pane · \`Ctrl+Shift+\\\` — outline
- **Ctrl** and **+** / **-** / **0** — bigger, smaller, reset

## Formatting happens as you type

Type \`## \` for a heading, \`- \` for a bullet, \`> \` for a quote — the line
becomes the thing. There is no preview pane because there is nothing to preview.

| It does | tables too |
| ------- | ---------- |
| and     | task lists |

- [ ] like this one
- [x] which you can tick

## If something goes wrong

Every save is atomic, so an interrupted write cannot corrupt a note. Every save
also records a version you can go back to, and if a file changes underneath you
— a sync client, another editor — Toril tells you rather than picking a winner.

---

Ctrl-click a link to open it in your browser: <https://github.com/kovirlabs/toril>
`;

export const EMPTY = `# Untitled

`;
