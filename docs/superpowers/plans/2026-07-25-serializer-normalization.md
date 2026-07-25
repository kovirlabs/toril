# Serializer Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Toril's canonical markdown agree with what Obsidian writes, so opening and saving an unmodified note is a byte-level no-op wherever achievable.

**Architecture:** A new `src/editor/canonical.ts` becomes the single definition of Toril's canonical markdown form — remark-stringify options plus a tight-list fix. Every editor construction in the app *and* in the test suite goes through it, so the canon under test cannot drift from the canon that ships. `serializer.ts` keeps its two-function contract untouched.

**Tech Stack:** TypeScript (strict, no `any`), Milkdown 7.21.1 (`@milkdown/kit`), remark-stringify, Vitest + jsdom, pnpm.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-25-serializer-normalization-design.md`. Read it before starting.
- **Branch:** `fix/serializer-normalization`, branched off `main` (not off `feat/sync-coexistence`).
- **Canonical style:** `-` bullets, `---` thematic breaks. Nothing else changes.
- **Never replace `remarkStringifyOptionsCtx` — always spread it.** Its default value is `{ handlers: remarkHandlers, ... }`; a bare object silently drops the handlers that make emphasis/strong marker-preservation work, introducing a normalization regression while fixing another.
- **All markdown conversion goes through `serializer.ts`** (CLAUDE.md §3.2). Do not add a second conversion path.
- **TypeScript strict, no `any`.** Run `pnpm typecheck` before every commit.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- **Full suite must be green before each commit:** `pnpm test` (expect 133 passing at start).
- Do **not** attempt Tier 3 constructs (setext headings, indented code, fence char, hard-break style, link references, escaping). They are pinned by tests, not fixed.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/editor/canonical.ts` *(create)* | The only definition of the canonical markdown form: stringify options + tight-list plugin. Exports `useCanonical(editor)`. |
| `src/editor/milkdown.ts` *(modify)* | Applies `useCanonical` when building the app editor. |
| `tests/roundtrip.test.ts` *(rewrite)* | Restructured into three fixture classes: `canonical`, `preserved`, `normalized`. |
| `tests/toolbar.test.ts` *(modify)* | Editor harness applies `useCanonical`; one hardcoded `***` assertion updated. |
| `tests/html-roundtrip.test.ts` *(modify)* | Editor harness applies `useCanonical` (it asserts via `docToMarkdown`). |
| `CLAUDE.md` *(modify)* | §0 "Known trade-off" rewritten; §8 gate description updated. |
| `CHANGELOG.md` *(modify)* | `[Unreleased]` entry for the behavior change. |
| `docs/superpowers/specs/2026-07-24-sync-coexistence-design.md` *(modify)* | §7 Tiers 1–2 marked resolved; Tier 3 rationale corrected. |

`tests/outline.test.ts` and `tests/security.test.ts` also construct editors but never assert canonical markdown — leave them alone.

---

## Task 1: Spike the tight-list fix mechanism

Decides whether Tier 2 ships as a local schema override or a committed `pnpm patch`. **Throwaway code — nothing from this task is committed except the recorded decision.**

**Files:**
- Create (temporary, deleted in Step 6): `tests/zz-spike.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a decision recorded in the task's commit message — either "override works" (Task 3 path A) or "override fails" (Task 3 path B).

**Background you need:** Milkdown stores the list `spread` attribute as the **string** `"false"`/`"true"`. `bullet_list` and `list_item` forward that string to mdast, where `"false"` is truthy, so every bullet list serializes loose. `ordered_list` and `preset-gfm`'s task-list-item coerce with `=== "true"` and are already correct. A previous attempt to fix this by *replacing* `list_item.toMarkdown` silently dropped task-list checkboxes, because `preset-gfm` delegates to the base runner only for unchecked items.

- [ ] **Step 1: Write the spike**

Create `tests/zz-spike.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, rootCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { commonmark, bulletListSchema, listItemSchema } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { docToMarkdown } from "../src/editor/serializer";

const patchBulletList = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state
          .openNode("list", undefined, { ordered: false, spread: node.attrs.spread === "true" })
          .next(node.content)
          .closeNode();
      },
    },
  };
});

const patchListItem = listItemSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        // GFM's task runner owns checked items and already coerces correctly.
        if (node.attrs.checked != null) return base.toMarkdown.runner(state, node);
        state.openNode("listItem", undefined, { spread: node.attrs.spread === "true" });
        state.next(node.content);
        state.closeNode();
      },
    },
  };
});

async function roundtrip(md: string): Promise<string> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, md);
      ctx.set(remarkStringifyOptionsCtx, {
        ...ctx.get(remarkStringifyOptionsCtx),
        bullet: "-",
        rule: "-",
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(patchBulletList)
    .use(patchListItem)
    .create();
  const out = docToMarkdown(editor);
  await editor.destroy();
  root.remove();
  return out;
}

const cases: Record<string, string> = {
  tight: "- a\n- b\n",
  loose: "- a\n\n- b\n",
  nested: "- Parent\n  - Child\n  - Child two\n",
  ordered: "1. First\n2. Second\n",
  task: "- [ ] todo\n- [x] done\n",
  taskLoose: "- [ ] todo\n\n- [x] done\n",
  mixedNested: "- Parent\n  - [ ] child task\n  - plain\n",
};

describe("spike: extendSchema tight-list override", () => {
  for (const [name, input] of Object.entries(cases)) {
    it(`is byte-stable and idempotent: ${name}`, async () => {
      const once = await roundtrip(input);
      expect(once).toBe(input);
      expect(await roundtrip(once)).toBe(once);
    });
  }
});
```

- [ ] **Step 2: Run the spike**

Run: `pnpm vitest run tests/zz-spike.test.ts`

Two possible outcomes — record which one you get:

- **All 7 pass** → the override works. Task 3 takes **path A**.
- **`task`, `taskLoose`, or `mixedNested` fail** with checkboxes missing (e.g. received `- todo\n- done\n`) → `prev(ctx)` did not chain to the GFM-extended schema. Task 3 takes **path B**.

- [ ] **Step 3: If path A, confirm the override is load-bearing**

Only if all 7 passed. Temporarily comment out `.use(patchBulletList)` and `.use(patchListItem)`, re-run, and confirm `tight`, `nested`, `task`, `taskLoose`, and `mixedNested` now FAIL. This proves the tests are actually exercising the fix rather than passing by accident. Restore the two `.use(...)` lines afterward.

Run: `pnpm vitest run tests/zz-spike.test.ts`
Expected: 5 failures, `loose` and `ordered` still passing.

- [ ] **Step 4: If path B, verify the fallback patch instead**

Only if the override failed. Confirm the `pnpm patch` route works before committing to it:

```bash
pnpm patch @milkdown/preset-commonmark@7.21.1
```

This prints a temporary directory. In that directory's `lib/index.js`, make exactly two edits:

- In the `bullet_list` `toMarkdown` runner, change `spread: node.attrs.spread` to `spread: node.attrs.spread === "true"`.
- In the `list_item` `toMarkdown` runner, change `state.openNode("listItem", void 0, { spread: node.attrs.spread })` to `state.openNode("listItem", void 0, { spread: node.attrs.spread === "true" })`.

Do **not** change the `ordered_list` runner or anything in `preset-gfm` — both already coerce correctly.

Then commit the patch and re-run the spike with the two `.use(patch*)` lines removed:

```bash
pnpm patch-commit <the-temp-dir-it-printed>
pnpm vitest run tests/zz-spike.test.ts
```

Expected: all 7 pass with no schema overrides in play.

- [ ] **Step 5: Delete the spike**

```bash
rm tests/zz-spike.test.ts
```

The seven cases are re-created as real fixtures in Task 3. This file is scaffolding, not a gate.

- [ ] **Step 6: Record the decision**

If path B, the `pnpm patch` produced `patches/@milkdown__preset-commonmark@7.21.1.patch` and a `pnpm.patchedDependencies` entry in `package.json` — commit those. If path A, there is nothing to commit; record the decision in the Task 2 commit body instead and skip this step.

```bash
git add patches package.json pnpm-lock.yaml
git commit -m "fix(deps): patch Milkdown list spread coercion

The extendSchema override could not chain to the GFM-extended list_item
schema, so fixing spread that way dropped task-list checkboxes. Patch the
two toMarkdown runners that forward spread as a truthy string instead.

Remove this patch once Milkdown ships the upstream fix."
```

---

## Task 2: Canonical module and Tier 1 alignment

Creates `canonical.ts`, applies `-` bullets and `---` rules, and routes every markdown-asserting editor through it. Tight lists are still loose after this task — that is Task 3.

**Files:**
- Create: `src/editor/canonical.ts`
- Modify: `src/editor/milkdown.ts:72-87`
- Modify: `tests/roundtrip.test.ts:23-60`
- Modify: `tests/toolbar.test.ts:26-37`, `tests/toolbar.test.ts:152`
- Modify: `tests/html-roundtrip.test.ts:30-35`

**Interfaces:**
- Consumes: the Task 1 decision (path A adds a plugin here in Task 3; path B does not).
- Produces: `useCanonical(editor: Editor): Editor` — applies canonical stringify options and (from Task 3) the tight-list plugin. Every editor that asserts canonical markdown must be built through it.

- [ ] **Step 1: Write the failing test**

In `tests/roundtrip.test.ts`, change the `thematicBreak` fixture on line 52 from `***` to `---`:

```ts
  thematicBreak: "Above.\n\n---\n\nBelow.\n",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/roundtrip.test.ts -t "thematicBreak"`
Expected: FAIL — received `"Above.\n\n***\n\nBelow.\n"`.

- [ ] **Step 3: Create the canonical module**

Create `src/editor/canonical.ts`:

```ts
// The ONE definition of Toril's canonical markdown form (CLAUDE.md §3.2).
//
// Toril's serializer must agree with what external writers (Obsidian, Prettier)
// already produce, so that opening and saving an unmodified note is a byte-level
// no-op. Every editor that asserts canonical markdown — the app's and the gates'
// — is built through `useCanonical`, so the canon under test cannot drift from
// the canon that ships.
import type { Editor } from "@milkdown/kit/core";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";

/**
 * remark-stringify options defining Toril's canonical output.
 *
 * Only two entries, each chosen to match Obsidian's own writes. Everything else
 * stays at Milkdown's default: `fence` already emits backticks, `listItemIndent`
 * is already stable, and emphasis/strong are marker-preserved upstream (both
 * `*italic*` and `_italic_` round-trip byte-for-byte), so they need nothing.
 */
const CANONICAL_STRINGIFY_OPTIONS = {
  bullet: "-",
  rule: "-",
} as const;

/**
 * Apply Toril's canonical markdown form to an editor under construction.
 *
 * IMPORTANT: the stringify options are **spread onto** the existing value, never
 * substituted for it. `remarkStringifyOptionsCtx` defaults to
 * `{ handlers: remarkHandlers, ... }`, and those handlers are what preserve each
 * emphasis/strong node's original marker. Replacing the object drops them and
 * silently reverts `_italic_` to `*italic*` — introducing a normalization while
 * removing another.
 */
export function useCanonical(editor: Editor): Editor {
  return editor.config((ctx) => {
    ctx.set(remarkStringifyOptionsCtx, {
      ...ctx.get(remarkStringifyOptionsCtx),
      ...CANONICAL_STRINGIFY_OPTIONS,
    });
  });
}
```

- [ ] **Step 4: Apply it in the app editor**

In `src/editor/milkdown.ts`, add the import beside the other local imports:

```ts
import { useCanonical } from "./canonical";
```

Then wrap the builder chain. Replace lines 72-87 (`let editor = Editor.make()` through `.use(searchPlugin());`) so the chain is wrapped:

```ts
  let editor = useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial);
        if (onChange) {
          ctx.get(listenerCtx).markdownUpdated(() => onChange());
        }
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(emoji)
      .use(htmlConstructs)
      .use(listener)
      .use(searchPlugin()),
  );
```

- [ ] **Step 5: Apply it in the round-trip gate**

In `tests/roundtrip.test.ts`, add the import:

```ts
import { useCanonical } from "../src/editor/canonical";
```

and wrap the harness on lines 26-34:

```ts
  const editor = await useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, md);
      })
      .use(commonmark)
      .use(gfm)
      .use(emoji),
  ).create();
```

- [ ] **Step 6: Run the thematic-break test to verify it passes**

Run: `pnpm vitest run tests/roundtrip.test.ts -t "thematicBreak"`
Expected: PASS

- [ ] **Step 7: Update the remaining canonical fixtures for `-` bullets**

Bullets now serialize as `-`. In `tests/roundtrip.test.ts`, update these fixtures (lines 47-55). They stay **loose** — tight lists are Task 3:

```ts
  unorderedList: "- Item one\n\n- Item two\n",
  nestedList: "- Parent\n\n  - Child\n\n  - Child two\n",
  gfmTaskList: "- [ ] todo\n\n- [x] done\n",
```

Also update the header comment on lines 41-43, which currently claims Milkdown emits `***`:

```ts
// Authored in Toril's canonical serialization (src/editor/canonical.ts): `-`
// bullets and `---` thematic breaks, matching what Obsidian writes. Milkdown
// still emits *loose* lists here; the `preserved` class added later covers tight.
```

- [ ] **Step 8: Update the tight-list normalization test's expectation**

Still in `tests/roundtrip.test.ts`, the test on lines 84-92 uses `*` bullets. Update its input and expectation to `-` (it still asserts tight→loose; Task 4 inverts it):

```ts
    const tight = "- one\n- two\n- three\n";
    const out = await roundtrip(tight);
    expect(out).toBe("- one\n\n- two\n\n- three\n"); // tight → loose
```

- [ ] **Step 9: Apply the canon in the toolbar and HTML gates**

In `tests/toolbar.test.ts`, add the import and wrap `makeEditor`'s builder (lines 29-36):

```ts
import { useCanonical } from "../src/editor/canonical";
```

```ts
  return useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, md);
      })
      .use(commonmark)
      .use(gfm)
      .use(emoji),
  ).create();
```

In `tests/html-roundtrip.test.ts`, do the same for the shared editor (lines 30-35). Keep the shared long-lived editor — its comment records a real parse race under full-suite concurrency:

```ts
import { useCanonical } from "../src/editor/canonical";
```

```ts
  editor = await useCanonical(
    Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(gfm)
      .use(emoji)
      .use(htmlConstructs),
  ).create();
```

- [ ] **Step 10: Fix the one hardcoded thematic-break assertion**

In `tests/toolbar.test.ts:152`:

```ts
    expect(docToMarkdown(editor)).toContain("---");
```

Leave `toolbar.test.ts:90` (`["bulletList", "item", "* item"]`) and `:128` (`roundtrip("* [ ] todo")`) **alone**. Both sides of those assertions run through the same serializer, so they self-adjust and still pass. Changing them is churn.

- [ ] **Step 11: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all 133 tests pass, no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/editor/canonical.ts src/editor/milkdown.ts tests/roundtrip.test.ts tests/toolbar.test.ts tests/html-roundtrip.test.ts
git commit -m "feat(editor): align canonical markdown to Obsidian conventions

Toril now writes \`-\` bullets and \`---\` thematic breaks, matching what
Obsidian, Prettier, and most vault content already produce, so opening and
saving an unmodified note is closer to a byte-level no-op.

The canonical form now has one definition (src/editor/canonical.ts) that the
app editor and every markdown-asserting gate are built through, so the canon
under test cannot drift from the canon that ships. No test previously used
createEditor, and each gate hand-assembled its own editor — survivable while
the plugin lists matched, but not once canonical output depends on config.

The stringify options are spread onto the context default, never substituted:
that default carries the handlers preserving each emphasis node's original
marker, and replacing it would silently rewrite _italic_ to *italic*."
```

---

## Task 3: Tight-list fix and the preservation gate

Fixes Tier 2 and adds the fixture class that would have caught it.

**Files:**
- Modify: `src/editor/canonical.ts` (path A only)
- Modify: `tests/roundtrip.test.ts`

**Interfaces:**
- Consumes: `useCanonical(editor)` from Task 2; the path A/B decision from Task 1.
- Produces: a `preserved` fixture record in `roundtrip.test.ts` that later tasks extend.

- [ ] **Step 1: Delete the test that asserts the bug**

In `tests/roundtrip.test.ts`, delete the whole `it("normalizes formatting without losing content", ...)` block (including its leading comment, currently around lines 81-92). Its assertion — `tight → loose` — is the bug written down as a requirement, and this task makes it false. Deleting it here rather than later is what keeps this task's commit green; tight lists are covered by `preserved.tightBullets` below.

- [ ] **Step 2: Write the failing test**

In `tests/roundtrip.test.ts`, add a second fixture record directly below the existing `fixtures` object:

```ts
// Human/Obsidian-authored input that must survive a round-trip untouched. This
// class is the point of the gate: the `fixtures` above are authored in Toril's
// own canonical form, so they can only ever confirm that canonical input stays
// canonical — they cannot observe human input being mangled.
const preserved: Record<string, string> = {
  tightBullets: "- one\n- two\n- three\n",
  looseBullets: "- one\n\n- two\n",
  nestedTight: "- Parent\n  - Child\n  - Child two\n",
  tightOrdered: "1. First\n2. Second\n",
  tightTaskList: "- [ ] todo\n- [x] done\n",
  looseTaskList: "- [ ] todo\n\n- [x] done\n",
  mixedNested: "- Parent\n  - [ ] child task\n  - plain\n",
  thematicBreak: "Above.\n\n---\n\nBelow.\n",
  asteriskEmphasis: "Some *italic* and **bold** text.\n",
  underscoreEmphasis: "Some _italic_ and __bold__ text.\n",
};
```

And add the block that exercises it, inside the existing `describe`:

```ts
  for (const [name, md] of Object.entries(preserved)) {
    it(`preserves human-authored input: ${name}`, async () => {
      const once = await roundtrip(md);
      expect(once).toBe(md); // (1) the file is not rewritten
      const twice = await roundtrip(once);
      expect(twice).toBe(once); // (2) idempotent
    });
  }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run tests/roundtrip.test.ts -t "preserves human-authored input"`
Expected: FAIL on `tightBullets`, `nestedTight`, `tightTaskList`, and `mixedNested` — each received a loose list with blank lines between items. `looseBullets`, `tightOrdered`, `looseTaskList`, `thematicBreak`, and both emphasis fixtures should already PASS.

- [ ] **Step 4 (path A): Add the tight-list plugin**

Only if Task 1 chose path A. In `src/editor/canonical.ts`, add the imports:

```ts
import { bulletListSchema, listItemSchema } from "@milkdown/kit/preset/commonmark";
```

Add the two overrides above `useCanonical`:

```ts
// Milkdown stores the list `spread` attribute as the STRING "true"/"false" but
// declares it `validate: "boolean"`. `bullet_list` and `list_item` forward that
// string to mdast, where "false" is truthy — so every bullet list serializes
// loose regardless of its source. `ordered_list` and preset-gfm's task-list-item
// coerce with `=== "true"` and are already correct, which is why tight ordered
// lists and checkboxes already survive.
//
// Reported upstream. Delete these two overrides once Milkdown ships the fix; the
// `preserved` fixtures in tests/roundtrip.test.ts keep the behavior honest.
const tightBulletList = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state
          .openNode("list", undefined, { ordered: false, spread: node.attrs.spread === "true" })
          .next(node.content)
          .closeNode();
      },
    },
  };
});

const tightListItem = listItemSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        // GFM's task runner owns checked items and already coerces correctly.
        // Delegating rather than reimplementing is what keeps `- [ ]` checkboxes
        // from being dropped.
        if (node.attrs.checked != null) return base.toMarkdown.runner(state, node);
        state.openNode("listItem", undefined, { spread: node.attrs.spread === "true" });
        state.next(node.content);
        state.closeNode();
      },
    },
  };
});
```

Then apply them in `useCanonical`:

```ts
export function useCanonical(editor: Editor): Editor {
  return editor
    .config((ctx) => {
      ctx.set(remarkStringifyOptionsCtx, {
        ...ctx.get(remarkStringifyOptionsCtx),
        ...CANONICAL_STRINGIFY_OPTIONS,
      });
    })
    .use(tightBulletList)
    .use(tightListItem);
}
```

- [ ] **Step 4 (path B): Nothing to implement**

Only if Task 1 chose path B. The `pnpm patch` committed in Task 1 Step 6 already fixes this. Add a comment to `src/editor/canonical.ts` above `useCanonical` recording where the fix lives, so the next reader does not go looking for it:

```ts
// Tight lists are fixed by patches/@milkdown__preset-commonmark@7.21.1.patch,
// not here: Milkdown forwards the list `spread` attribute as the string "false"
// (truthy), so every bullet list serialized loose. An extendSchema override could
// not chain to the GFM-extended list_item and dropped task-list checkboxes.
// Remove the patch once Milkdown ships the upstream fix; the `preserved`
// fixtures in tests/roundtrip.test.ts keep the behavior honest.
```

- [ ] **Step 5: Run the preservation tests to verify they pass**

Run: `pnpm vitest run tests/roundtrip.test.ts -t "preserves human-authored input"`
Expected: all 10 PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass, with no skipped tests. The test that asserted tight→loose was deleted in Step 1, so the suite must be fully green here.

- [ ] **Step 7: Commit**

```bash
git add src/editor/canonical.ts tests/roundtrip.test.ts
git commit -m "fix(editor): preserve tight lists through a round-trip

Milkdown stores the list \`spread\` attribute as the string \"false\" and
forwards it to mdast, where it is truthy — so every bullet list serialized
loose no matter how it was written. Ordered lists coerce correctly, which is
why they already survived.

Adds a preservation fixture class: human/Obsidian-authored input must round-trip
byte-for-byte. The existing fixtures are authored in Toril's own canonical form,
so they could only confirm that canonical input stays canonical — which is how a
bug touching every bullet line in a vault stayed green through 133 tests."
```

---

## Task 4: Pin the residual normalizations

Converts the remaining Tier 3 reformatting from prose into executable expectations. (The test that asserted tight→loose was already deleted in Task 3 Step 1.)

**Files:**
- Modify: `tests/roundtrip.test.ts`

**Interfaces:**
- Consumes: `roundtrip()` and the `preserved` record from Task 3.
- Produces: a `normalized` fixture record — the executable form of spec §7's residual list, which `feat/sync-coexistence` reasons about.

- [ ] **Step 1: Write the failing test**

Add a third fixture record below `preserved`:

```ts
// Input that Toril legitimately rewrites. Each entry pins the EXACT output, so
// the residual reformatting is executable rather than prose — `feat/sync-coexistence`
// reasons about its conflict rate from this list. These are not bugs: the node
// carries no record of its original syntax, and fixing that would mean threading
// original-markup attributes through every node (CLAUDE.md §11).
const normalized: Record<string, [input: string, output: string]> = {
  setextHeading: ["Title\n=====\n\nBody text.\n", "# Title\n\nBody text.\n"],
  indentedCode: ["    const x = 1\n", "```\nconst x = 1\n```\n"],
  tildeFence: ["~~~js\nconst x = 1\n~~~\n", "```js\nconst x = 1\n```\n"],
  hardBreakSpaces: ["line one  \nline two\n", "line one\\\nline two\n"],
  linkReference: [
    "See [example][ex].\n\n[ex]: https://example.com\n",
    "See [example](https://example.com).\n",
  ],
  asteriskBullets: ["* one\n* two\n", "- one\n- two\n"],
  asteriskRule: ["Above.\n\n***\n\nBelow.\n", "Above.\n\n---\n\nBelow.\n"],
  underscoreRule: ["Above.\n\n___\n\nBelow.\n", "Above.\n\n---\n\nBelow.\n"],
  tablePadding: ["| A | B |\n|---|---|\n| 1 | 2 |\n", "| A | B |\n| - | - |\n| 1 | 2 |\n"],
  intrawordUnderscore: [
    "A literal asterisk \\* and an underscore_in_word here.\n",
    "A literal asterisk \\* and an underscore\\_in\\_word here.\n",
  ],
  emojiShortcode: ["Hello :smile: world\n", "Hello 😄 world\n"],
};
```

And the block exercising it, replacing the emoji test (lines ~94-100), which this subsumes:

```ts
  for (const [name, [input, output]] of Object.entries(normalized)) {
    it(`normalizes to an exact, stable form: ${name}`, async () => {
      const once = await roundtrip(input);
      expect(once).toBe(output); // (1) the exact rewrite, not merely "something"
      expect(await roundtrip(once)).toBe(once); // (2) idempotent — no slow drift
    });
  }
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/roundtrip.test.ts -t "normalizes to an exact"`
Expected: all 11 PASS. These pin behavior that already exists, so failures mean a measurement was wrong — investigate the actual output rather than editing the expectation to match.

- [ ] **Step 3: Update the file header comment**

The header (lines 1-14) describes two properties and one fixture class. Replace it:

```ts
// Phase 1 GATE (CLAUDE.md §3.2, §8): markdown ⇄ document must be lossless.
//
// We build a real Milkdown editor through src/editor/canonical.ts — the same
// canonical form the app ships — and round-trip through serializer.ts, the single
// canonical converter. Three fixture classes, each asking a different question:
//
//   1. `fixtures`  — canonical input round-trips byte-for-byte and is idempotent.
//   2. `preserved` — HUMAN/Obsidian-authored input round-trips byte-for-byte.
//                    This is the class with teeth: the canonical fixtures are
//                    authored in our own output form, so they can only confirm
//                    that canonical input stays canonical. A serializer bug that
//                    rewrote every bullet line in a vault stayed green for 133
//                    tests because nothing asked this question.
//   3. `normalized` — input we legitimately rewrite, pinned to its EXACT output.
//                    Not bugs: the node records no original syntax. Keeping the
//                    list executable is what lets sync-coexistence reason about
//                    its conflict rate.
//
// If a Milkdown upgrade changes serialization, this fails loudly here before it
// can reformat a user's notes.
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass, no skipped tests remaining.

- [ ] **Step 5: Commit**

```bash
git add tests/roundtrip.test.ts
git commit -m "test(roundtrip): pin residual normalizations to exact outputs

Splits the gate into three fixture classes and deletes the test that asserted
tight->loose as a requirement. The residual reformatting — setext headings,
indented code, fence and rule characters, hard-break style, link references,
escaping — is now pinned to exact expected output rather than described in
prose, so feat/sync-coexistence can reason about its conflict rate from tests."
```

---

## Task 5: Documentation

Brings the repo's prose in line with the new behavior, including a claim that is now provably wrong.

**Files:**
- Modify: `CLAUDE.md:44-46`, `CLAUDE.md` §8 gates list
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/superpowers/specs/2026-07-24-sync-coexistence-design.md` §7

**Interfaces:**
- Consumes: the completed behavior from Tasks 2-4.
- Produces: nothing code-facing.

- [ ] **Step 1: Rewrite the CLAUDE.md known trade-off**

`CLAUDE.md` lines 44-46 currently read:

> **Known trade-off:** formatting normalizes to Milkdown's canonical form on first save (tight→loose lists, `---`→`***`). It reformats whitespace but never drops content and is idempotent thereafter — relevant to Obsidian-vault diffs (§1).

Both examples are now false. Replace it:

```markdown
**Known trade-off:** Toril's canonical form (`src/editor/canonical.ts`) is `-` bullets and `---`
thematic breaks, matching Obsidian — so most notes survive open→save untouched. What still
reformats: setext headings, indented code blocks, `~~~` fences, two-space hard breaks, link
reference definitions, and `*`-authored bullets/rules. Each is pinned to an exact expected output
by the `normalized` class in `tests/roundtrip.test.ts`. It never drops content and is idempotent —
relevant to Obsidian-vault diffs (§1).
```

- [ ] **Step 2: Update the §8 round-trip gate description**

In `CLAUDE.md` §8, the round-trip bullet currently reads:

> - **Round-trip:** `tests/roundtrip.test.ts` — real Milkdown in jsdom; CommonMark + GFM + emoji. Add math + front-matter fixtures when those land (§3.2).

Replace it:

```markdown
- **Round-trip:** `tests/roundtrip.test.ts` — real Milkdown in jsdom, built through
  `canonical.ts` so the gate tests the canon that ships. Three classes: `fixtures`
  (canonical input is stable), `preserved` (human/Obsidian-authored input is **not**
  rewritten), `normalized` (what we do rewrite, pinned to exact output). Add math +
  front-matter fixtures when those land (§3.2).
```

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add a `### Changed` section above the existing `### Added` (create the heading if absent):

```markdown
### Changed
- **Canonical markdown now matches Obsidian.** Toril writes `-` bullets and `---`
  thematic breaks, and no longer converts tight lists to loose ones — a Milkdown
  bug that forwarded the list `spread` attribute as a truthy string, reported
  upstream. Notes written by Obsidian or by hand now generally survive an
  open→save cycle untouched, which matters when the folder is a live vault or is
  synced by iCloud/OneDrive/Dropbox.

  **Existing notes re-normalize lazily** — only when you next save a note anyway,
  never in bulk, so nothing rewrites files you did not choose to write. Because
  every save records a version-history snapshot first, that re-normalization is
  undoable per note from the history panel.
```

> **Not here:** the sync-coexistence spec's §7 also needs correcting, but that
> file (`docs/superpowers/specs/2026-07-24-sync-coexistence-design.md`) exists
> only on `feat/sync-coexistence`, not on a branch cut from `main`. It is updated
> in Task 6 Step 3, after the rebase.

- [ ] **Step 4: Verify nothing else references the old behavior**

Run: `grep -rn 'tight→loose\|tight->loose\|`---`→`\*\*\*`' CLAUDE.md README.md docs/ ROADMAP.md`
Expected: no hits outside the two spec files' historical narrative sections. Fix any stragglers.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: record the new canonical form

CLAUDE.md's known-trade-off paragraph cited tight→loose lists and ---→***
as the normalization; both are now false, so it is rewritten rather than
appended to, and lists what actually still reformats.

Adds the CHANGELOG entry for the behavior change, including that existing
notes re-normalize lazily and that the rewrite is undoable per note via the
existing snapshot history."
```

---

## Task 6: Rebase sync-coexistence

**Files:** none — git operations only.

**Interfaces:**
- Consumes: the merged `fix/serializer-normalization`.
- Produces: `feat/sync-coexistence` rebased onto the new canon.

- [ ] **Step 1: Confirm the branch is green and merge it**

Run: `pnpm test && pnpm typecheck`
Expected: all pass. Then merge `fix/serializer-normalization` into `main` per the project's normal PR flow.

- [ ] **Step 2: Rebase the dependent branch**

```bash
git checkout feat/sync-coexistence
git rebase main
```

`feat/sync-coexistence` contains only spec commits at this point, so conflicts are unlikely. The spec and plan docs were cherry-picked onto the precursor branch, so git will recognise the identical patches and drop the duplicates.

- [ ] **Step 3: Correct the sync-coexistence spec §7**

Now that the file is on the current branch, make two changes to
`docs/superpowers/specs/2026-07-24-sync-coexistence-design.md` §7.

First, in the tier table, change the Tier 1 and Tier 2 "Fixable?" cells to record that they are done:

```markdown
| **1 — cosmetic** | ... | ... | **Done** — `fix/serializer-normalization` |
| **2 — upstream bug** | ... | ... | **Done** — `fix/serializer-normalization` |
```

Second, the Tier 3 row's rationale is wrong as a blanket claim. It reads "ProseMirror's doc model is normalized; no node records its original syntax." Milkdown *does* record original syntax for emphasis and strong via `node.marker`. Replace that cell:

```markdown
| **3 — schema-level** | setext headings, indented code blocks, hard-break style, link references + definitions, escaping | These nodes record no original syntax — though Milkdown's `node.marker` mechanism shows it is extensible, at a cost we chose not to pay | **No** — see `2026-07-25-serializer-normalization-design.md` §4.4 |
```

Then commit:

```bash
git add docs/superpowers/specs/2026-07-24-sync-coexistence-design.md
git commit -m "docs(specs): mark §7 tiers 1-2 resolved, correct tier 3 rationale

Tier 3 claimed no node records its original syntax, but Milkdown does exactly
that for emphasis and strong via node.marker — the tier is 'not modelled today,
extensible at a cost we chose not to pay', not 'impossible'."
```

- [ ] **Step 4: Verify**

```bash
pnpm test && pnpm typecheck
git log --oneline main..feat/sync-coexistence
```

Expected: all tests pass; the log shows only the sync-coexistence spec commits.

- [ ] **Step 5: On-device verification**

The change is pure logic and fully gated headlessly, so the risk is low — but it changes what gets written to the user's files, and no gate exercises the real save path. Confirm on a webview-capable machine (this box qualifies; see the dev-server-environment notes):

```bash
pnpm tauri dev
```

Then, against a scratch folder — **not** a real vault:

1. Create a note in an external editor containing a tight bullet list, a nested tight list, a `- [ ]` task list, and a `---` rule.
2. Open it in Toril, change one word in a paragraph, and save.
3. Diff the file against the original.

Expected: only the paragraph you edited differs. Bullets stay `-` and tight, checkboxes intact, `---` unchanged. If list spacing or markers moved, the canon is not reaching the app editor — check that `useCanonical` wraps the builder in `src/editor/milkdown.ts` rather than being applied to a discarded intermediate.

4. Open a note Toril saved **before** this branch (loose lists, `*` bullets), save it, and confirm it re-normalizes once, then stays stable on a second save. Confirm the pre-normalization version is recoverable from the history panel.

---

## Definition of Done

- `src/editor/canonical.ts` is the only definition of the canonical form, consumed by `milkdown.ts` and all three markdown-asserting gates.
- Stringify options applied by spreading, never replacing.
- Tight lists preserved via the spiked override or the committed `pnpm patch`, with its removal condition documented.
- All seven list cases byte-stable and idempotent, checkboxes intact.
- `roundtrip.test.ts` has three fixture classes; the tight→loose test is gone, not edited.
- `pnpm test` and `pnpm typecheck` green.
- Docs updated, including the §7 correction.
- `feat/sync-coexistence` rebased onto the result.
