# Sync Coexistence — On-Device Verification Checklist

> Task 14 of `docs/superpowers/plans/2026-07-25-sync-coexistence.md`. Everything here is
> a flow that unit tests structurally cannot reach: `src/main.ts` has no test harness
> (it needs a live Milkdown editor and Tauri IPC), and the watcher only fires against a
> real filesystem.
>
> **Use a scratch folder, not a real vault.** Several steps deliberately create conflict
> copies and delete files.

```bash
pnpm tauri dev
```

Items 6–12 exist because a reviewer found a specific bug there. Those are the ones worth
doing first if you only have time for some.

---

## Core flows

- [ ] **1. Non-overlapping edits merge.** Create `note.md` with ten numbered lines. Open it.
      Edit line 1 in Toril, don't save. In another editor, edit line 10 and save.
      *Expect:* within ~250 ms, "Merged external changes… review and save", both edits
      present, tab still dirty. Save, then diff: both edits, nothing else changed.

- [ ] **2. Overlapping edits park the losing side.** Same file. Edit line 5 in Toril, don't
      save. Edit line 5 differently outside, save.
      *Expect:* the banner, not a merge. Click **Keep mine** → a `note (conflict …).md`
      appears containing *the other editor's* version; banner clears; your buffer stays
      dirty with your text. Repeat and click **Use theirs** → conflict copy contains
      *your* text; buffer reloads to theirs.

- [ ] **3. The pre-save check catches what the watcher missed.** Best-effort: edit an open
      note without saving, then change it from another machine over a network share or a
      synced folder.
      *Expect:* Save raises the banner rather than silently overwriting.

- [ ] **4. Event bursts don't spam the banner.** With a sync client running, `touch note.md`
      several times in a second.
      *Expect:* at most one reconcile per burst, no flicker.

- [ ] **5. External deletion keeps the buffer.** Delete the open file from outside Toril.
      *Expect:* "removed on disk — save to recreate it", buffer intact, File → Save
      recreates the file.

---

## Flows that had a bug found in them

- [ ] **6. An unedited note is not treated as edited.** *(HIGH-1)* Create a note with **CRLF
      line endings** or `*` bullets — anything Toril canonicalises. Open it and **touch
      nothing**. Change one line from outside and save.
      *Expect:* a silent reload. **Not** a conflict banner, and **not** a dirty tab.
      Then turn autosave on and repeat.
      *Expect:* the file on disk still has its CRLF/`*` formatting — Toril must not have
      written a whole-file reformat of a note you never edited.

- [ ] **7. Typing during a reconcile doesn't lose keystrokes.** *(HIGH-2)* Open a note in a
      synced folder. Have the sync client write to it, and **keep typing continuously**
      through the reconcile.
      *Expect:* nothing you typed disappears. Either the merge applies without eating your
      characters, or you get a conflict banner — both are fine; silently losing the last
      burst is not.

- [ ] **8. A deleted note's buffer survives a kill.** *(MEDIUM-3)* Open a note, leave it
      **clean**, wait a minute so autosave's debounce has fired and cleared. Delete the
      file from outside. Now kill Toril (task manager / `kill -9`, not File → Quit).
      Relaunch.
      *Expect:* the buffer comes back from the recovery journal. This is the case where
      the only surviving copy was in memory.

- [ ] **9. Save All doesn't resurrect a deleted file.** *(MEDIUM-4)* Open two notes. Rename
      one of them in Obsidian (or delete + create elsewhere). Edit the *other* note, then
      press Save All.
      *Expect:* the renamed note is **not** recreated at its old path, and the status line
      names it as skipped. Then open that tab and File → Save.
      *Expect:* now it recreates.

- [ ] **10. The error state makes no false promise.** `chmod 000` an open file (or lock it
      from another process), then trigger a reconcile.
      *Expect:* the banner appears with **no buttons** and **no** "Either way, the other
      version is saved beside it" — nothing was parked, so it must not claim otherwise.

- [ ] **11. Restore cancels on a tab switch.** Open the history panel on tab X, click
      Restore, and switch to tab Y while the IPC is in flight.
      *Expect:* the restore cancels cleanly. Tab Y's content must **not** be written to
      tab X's path, and Y must not be marked clean.

- [ ] **12. Screen-reader announcement.** With NVDA / VoiceOver running, trigger a conflict.
      *Expect:* the banner is announced when it appears. If it is silent, the live region
      still isn't working — the visible text is unaffected either way.

---

## Known limits — confirm the behaviour, don't file these as bugs

- **The TOCTOU window.** Between Toril's disk check and the write that follows it, a change
  landing in that instant is still overwritten without being flagged. It *is* recoverable
  from version history (the pre-overwrite bytes are snapshotted), but `reconcile` will not
  notice it afterwards. Closing this needs a compare-and-swap inside `save_file`.

- **Adjacent-hunk merges.** Toril merges some cases `git` would conflict on, because git
  requires three lines of context between hunks and this line-based diff3 does not. Content
  and ordering are correct; it is simply less conservative than git.

- **Repeated identical lines.** With duplicate lines, the merge can pick a different (still
  valid) decomposition than git. 84 of 16,182 cases differed in testing; none corrupted.
