# Design — Serializer Normalization (`fix/serializer-normalization`)

> Precursor to `feat/sync-coexistence` (ROADMAP Movement I.4). Toril's markdown
> serializer reformats lines no human edited, which inflates the conflict rate of
> any 3-way merge against an externally-authored note. This branch removes the
> two causes that are removable and pins the rest with tests, so sync-coexistence
> starts from a clean merge base.
>
> This is a **data-safety-adjacent** branch: it changes what Toril writes to the
> user's files. Every change must be lossless and idempotent (CLAUDE.md §3.2).

- **Date:** 2026-07-25
- **Branch:** `fix/serializer-normalization`, off `main`
- **Status:** approved design → implementation
- **Sequencing:** lands first; `feat/sync-coexistence` rebases onto it

---

## 1. Goal & non-goals

**Goal.** Make Toril's canonical markdown agree with what external writers
(Obsidian, Prettier, most vault content) already produce, so that opening and
saving an unmodified note is a byte-level no-op wherever that is achievable.

**Non-goals.**

- **No merge, conflict, or watcher work.** That is `feat/sync-coexistence`.
- **No per-node marker preservation** (§4.4). Global alignment covers the common
  case; preservation is recorded as the upgrade path, not built.
- **No bulk re-normalization tool.** Re-normalization is lazy (§3).
- **No attempt at Tier 3** (§2). Those constructs are pinned by tests, not fixed.
- **No settings surface.** The canonical form is fixed, not configurable.

---

## 2. Background — what actually normalizes

Measured 2026-07-25 against the real `serializer.ts` (Milkdown 7.21.1, probe
through a live editor in jsdom), not inferred from the changelog. The
reformatting has three distinct causes with very different costs:

| Tier | Constructs | Cause | Action |
|---|---|---|---|
| **1 — cosmetic** | `*` vs `-` bullets, `***` vs `---` rules, table cell padding | `remark-stringify` global output options | **Align** to what Obsidian writes (§4.1) |
| **2 — upstream bug** | tight → loose lists | Milkdown coercion slip (below) | **Fix** locally (§4.2) |
| **3 — not modelled** | setext headings, indented code, fence char, hard-break style, link references, escaping | The node carries no record of its original syntax | **Pin** with tests (§5) |

### 2.1 The Tier 2 bug

Tightness *is* modelled — `parseMarkdown` captures it correctly — but the
attribute is stored as a **string** and two of four `toMarkdown` sites forward it
raw to mdast, where the string `"false"` is truthy:

```js
// bullet_list — forwards the raw string  ❌
state.openNode('list', undefined, { ordered: false, spread: node.attrs.spread })
// ordered_list — coerces  ✅  (which is why tight ordered lists already survive)
spread: node.attrs.spread === 'true'
```

`preset-gfm`'s task-list-item also coerces correctly and delegates to the base
`list_item` runner only for unchecked items, so the bug is masked for `- [ ]`
rows and visible for ordinary ones.

A second symptom: `schema.nodeFromJSON()` **throws** on any document containing a
list — `Expected value of type boolean for attribute spread on type list_item,
got string` — because the attrs declare `validate: "boolean"`. An upstream report
and patch are drafted; see §7.

### 2.2 What is already fine

`emphasis` and `strong` are **marker-preserved upstream** and were never a
conflict source: `*italic*` and `_italic_` are both byte-stable today. Milkdown's
`$remark` marker plugin records the source character on the mdast node, and its
custom stringify handlers honor it with a three-level fallback:

```js
const marker = node.marker || state.options.emphasis || '*'
```

Only `text`, `strong`, and `emphasis` have such handlers. This matters twice: it
is the mechanism §4.4 declines to extend, and it is the reason for the config
constraint in §4.1.

---

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Canonical style | `-` bullets, `---` rules | Matches Obsidian, Prettier, and most vault content — minimizing diffs is the entire point |
| Tier 2 method | Spike a local `extendSchema` override; fall back to a committed `pnpm patch` | The override is *unproven*, not merely unwritten (§4.2) |
| Existing notes | **Lazy** re-normalization on next save; no bulk tool | Never writes a file the user did not already choose to write, and avoids a mass rewrite rippling through a sync client |
| Test strategy | Three fixture classes, incl. a new **preservation** class | Today's gate is circular (§5) |

**Alignment is not preservation.** Setting `bullet: "-"` does not preserve the
input marker; it changes which marker wins globally. A vault authored with `*`
bullets will be rewritten to `-` — churn moves rather than disappears. This is
accepted because Obsidian's own default is `-`.

---

## 4. The change

### 4.1 Tier 1 — exactly two options

```ts
{ bullet: "-", rule: "-" }
```

Everything else stays at its default, each checked rather than assumed: `fence`
already emits backticks, `listItemIndent` is already stable, and emphasis/strong
need nothing (§2.2).

**Constraint — spread, never replace.** `remarkStringifyOptionsCtx` defaults to
`{ handlers: remarkHandlers, ... }`. Setting it with a bare object silently drops
those handlers and reverts emphasis/strong to a single global marker,
*introducing* a normalization regression while fixing another:

```ts
ctx.set(remarkStringifyOptionsCtx, {
  ...ctx.get(remarkStringifyOptionsCtx),
  bullet: "-",
  rule: "-",
})
```

### 4.2 Tier 2 — spike first, then fix

**Step 0 is a spike, not a commit.** Prove an `extendSchema` override can coerce
`spread` *and* still compose with GFM's task-list runner.

This is unproven for a specific reason: an override that replaces
`list_item.toMarkdown` **silently drops task-list checkboxes** (`- [ ] todo` →
`- todo`), because `preset-gfm` delegates to the base runner only for unchecked
items. An attempt to delegate back via `prev(ctx)` also dropped them, suggesting
the override does not chain to the GFM-extended schema. That is a §3 data-loss
failure mode, so it must be proven, not assumed.

**Pass condition** — these seven cases byte-stable **and** idempotent, with
checkboxes intact, **with the §4.1 options applied** (so the inputs use `-`, the
post-alignment canon):

| Case | Input |
|---|---|
| tight | `- a\n- b\n` |
| loose | `- a\n\n- b\n` |
| nested | `- Parent\n  - Child\n  - Child two\n` |
| ordered | `1. First\n2. Second\n` |
| task | `- [ ] todo\n- [x] done\n` |
| task loose | `- [ ] todo\n\n- [x] done\n` |
| mixed nested | `- Parent\n  - [ ] child task\n  - plain\n` |

> These seven shapes were verified against the patched bundle with `*` inputs,
> *before* Tier 1 was applied. Run the spike with Tier 1 already in place and the
> inputs re-authored to `-`; otherwise the bullet rewrite alone fails the
> byte-stability assertion and masks the result.

**Fallback if the spike fails:** a committed `pnpm patch` carrying the two-line
coercion fix, already verified end-to-end against the published bundle. It
follows CLAUDE.md §2's vendored-`glib` precedent — a patched dependency with a
documented removal condition (here: any Milkdown release fixing `spread`). The
rest of the branch is identical either way, so this de-risks without forking the
design.

### 4.3 Module layout

**New — `src/editor/canonical.ts`.** The single definition of Toril's canonical
markdown form, exporting the stringify option set and the tight-list plugin.
Nothing else imports Milkdown's list schemas. `serializer.ts` keeps its
two-function contract (§3.2) untouched.

**Close the app/gate divergence.** No test currently uses `createEditor` — both
round-trip gates hand-assemble their own editor from the same plugin list, a
hazard `html-constructs.ts:179` already comments on. That is survivable while the
lists match, but the moment canonical output depends on *configuration*, a gate
that does not pick it up is testing a serializer nobody ships. `canonical.ts` is
therefore consumed by `milkdown.ts` **and** by both round-trip gates.

Keep `html-roundtrip.test.ts`'s shared long-lived editor — its comment records a
real parse race under full-suite concurrency, worth not rediscovering.

### 4.4 Deliberately not doing — marker preservation

The mechanism from §2.2 extends to `thematicBreak`: visit it in a `$remark`
plugin, add a handler honoring `node.marker`. That would be strictly better in
principle — a `***`-authored vault would stay stable too.

Declined because the payoff is limited to vaults using `***`/`___`, which is rare
when Obsidian writes `---`. Extending it to *bullets* is the real cost: a
hand-written `listItem` handler covering spread, checked state, ordered
numbering, indentation, and `bulletOther` disambiguation — a large custom surface
against §11's "minimize custom schema", for a case global alignment covers.

Recorded here as the upgrade path if preservation ever proves necessary.

---

## 5. Gates

**Today's gate is circular.** Its fixtures are authored in Milkdown's canonical
form — the file comment says so — so it asks "does canonical input stay
canonical?" and can never observe that human input gets mangled. That is why a
bug touching every bullet line in a vault sat green through 133 passing tests,
and why the test named *"normalizes formatting without losing content"* asserts
`tight → loose` as a **requirement**.

`tests/roundtrip.test.ts` is restructured into three named fixture classes:

| Class | Property | Fixtures |
|---|---|---|
| `canonical` | Round-trips byte-for-byte; idempotent | Existing set, re-authored to `-`/`---`/tight |
| **`preserved`** *(new)* | **Human/Obsidian-authored** input round-trips byte-for-byte | Tight bullets, nested tight, tight task lists, `---`, ordered tight, both emphasis markers |
| `normalized` *(reframed)* | Changes to an **exact** expected output; idempotent; content survives | setext→ATX, indented→fenced, `~~~`→backticks, two-space→backslash break, link-reference→inline, `*`→`-`, `***`→`---`, `:smile:`→😄, table padding |

The `normalized` class is what makes the Tier 3 residue **executable** rather than
prose, so `feat/sync-coexistence` can reason about its conflict rate from tests.

The "normalizes formatting without losing content" test is **inverted** and moved
into `preserved` — not updated in place. Its current assertion is the bug written
down as a requirement.

**Known collateral**, already located:

| Location | Change |
|---|---|
| `tests/toolbar.test.ts:90` | `["bulletList", "item", "* item"]` → `- item` |
| `tests/toolbar.test.ts:128` | task-list fixture input → `-` |
| `tests/toolbar.test.ts:152` | `toContain("***")` → `"---"` |

Run the full suite to catch anything beyond these rather than assuming that is
all.

**Unchanged gates that must stay green:** `html-roundtrip`, `export`, `security`,
`tabs`, `history`, `autosave`, `outline`, `search`, `statusbar`, `theme`, and all
Rust logic crates.

---

## 6. Docs to update

- **`CLAUDE.md §0`** — the "Known trade-off" paragraph states the normalization as
  `tight→loose lists, ---→***`. That is the precise claim this branch falsifies,
  so it is **rewritten**, not appended to.
- **`CLAUDE.md §8`** — the round-trip gate description, for the three fixture
  classes.
- **`CHANGELOG.md`** — `[Unreleased]`, documenting lazy re-normalization so the
  behavior change is discoverable.
- **`docs/superpowers/specs/2026-07-24-sync-coexistence-design.md` §7** — mark
  Tiers 1–2 as resolved by this branch, and correct its Tier 3 rationale (see
  §7 of *this* spec for what is wrong with it).

---

## 7. Risks & known limitations

- **The §7 rationale in the sync-coexistence spec is wrong as written.** Commit
  `70e712b` justifies Tier 3 as *"ProseMirror's doc model is normalized; no node
  records its original syntax."* As a blanket claim that is false — Milkdown
  records original syntax for emphasis/strong via `node.marker` (§2.2). Tier 3 is
  better stated as *not modelled today, extensible at a cost we are choosing not
  to pay*. Corrected as part of this branch.
- **Churn is real but bounded and undoable.** The first save of an
  already-Toril-saved note rewrites its markers. Because every save already
  records a content-addressed snapshot (`crates/snapshots`), the pre-normalization
  bytes are snapshotted *first*, making the re-normalization undoable per note
  through the existing history panel.
- **`*`-authored vaults get churn instead.** §3 accepts this.
- **A `pnpm patch` fallback targets the built bundle**, so a Milkdown version bump
  can break it noisily. Preferred failure mode over silent drift, but it is why
  the spike comes first.
- **On-device verification** is unavailable for GUI flows here (§0). The change is
  pure logic and fully gated headlessly, so risk is low, but confirm a real
  open→edit→save cycle on a webview-capable machine before release.

**Non-blocking follow-up:** post the upstream Milkdown issue. If it is fixed
upstream, the Tier 2 override is deleted and the `preserved` fixtures keep the
behavior honest.

---

## 8. Definition of done

- `src/editor/canonical.ts` exists and is the only definition of the canonical
  form; consumed by `milkdown.ts` and both round-trip gates.
- Tier 1 options applied by spreading, never replacing (§4.1).
- Tier 2 fixed via the spiked override, or the `pnpm patch` fallback with its
  removal condition documented.
- All seven §4.2 cases byte-stable and idempotent, checkboxes intact.
- `roundtrip.test.ts` restructured into the three classes; the inverted test lives
  in `preserved`.
- Full suite green (`pnpm test`, `pnpm typecheck`); `cargo fmt` + `cargo clippy`
  clean on first-party crates (§10).
- Docs in §6 updated, including the §7 correction.
- `feat/sync-coexistence` rebased onto this branch.
