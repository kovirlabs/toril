// Autosave + crash-recovery journal (CLAUDE.md §3, ROADMAP Movement I.1).
//
// Two safety mechanisms on one debounce:
//  - the recovery journal (always on) snapshots every dirty buffer so a
//    crash/kill can't lose unsaved work;
//  - autosave (opt-in) persists dirty, path-backed tabs to their real files via
//    the existing atomic save path.
//
// This module is pure: every side effect (serialize, disk, journal I/O) is
// injected, so the debounce + selection logic is unit-testable with fake timers
// and no Tauri/DOM. The wiring lives in main.ts (§0: on-device verified).

/** A dirty buffer captured for crash recovery. Mirrors Rust `RecoveryEntry`. */
export interface RecoveryEntry {
  id: string;
  /** Absolute path, or null for an unsaved "Untitled" buffer. */
  path: string | null;
  name: string;
  /** Canonical content in `format` — one serializer per format (§3.2). */
  content: string;
  format: "markdown" | "html";
}

/** The minimal tab shape the selection helpers need (structural — TabState fits). */
export interface BufferLike {
  id: string;
  path: string | null;
  name: string;
  content: string;
  format: "markdown" | "html";
  dirty: boolean;
}

export interface AutosaveDeps {
  /** Snapshot every currently-dirty buffer (caller serializes the active tab first). */
  snapshotDirtyBuffers(): RecoveryEntry[];
  /** Persist the recovery journal (pass [] to clear it). */
  writeJournal(entries: RecoveryEntry[]): Promise<void>;
  /** Save every dirty, path-backed tab through the atomic save path. */
  saveDirtySaved(): Promise<void>;
}

export interface AutosaveConfig {
  enabled: boolean;
  debounceMs: number;
}

const DEFAULT_DEBOUNCE_MS = 2000;

/** Dirty buffers that have a path — the only ones autosave may write (§3). */
export function selectDirtySaved<T extends BufferLike>(buffers: readonly T[]): T[] {
  return buffers.filter((b) => b.dirty && b.path !== null);
}

/** Snapshot every dirty buffer (Untitled included) for the recovery journal. */
export function snapshotDirty(buffers: readonly BufferLike[]): RecoveryEntry[] {
  return buffers
    .filter((b) => b.dirty)
    .map((b) => ({ id: b.id, path: b.path, name: b.name, content: b.content, format: b.format }));
}

export class AutosaveScheduler {
  private enabled: boolean;
  private debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: AutosaveDeps,
    cfg: Partial<AutosaveConfig> = {},
  ) {
    this.enabled = cfg.enabled ?? false;
    this.debounceMs = cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  setConfig(cfg: Partial<AutosaveConfig>): void {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled;
    if (cfg.debounceMs !== undefined && cfg.debounceMs > 0) this.debounceMs = cfg.debounceMs;
  }

  /** (Re)arm the debounce; a quiet `debounceMs` window triggers a flush. */
  notifyChange(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /**
   * Run the tick now: always rewrite the journal from the current dirty set,
   * and when enabled also autosave dirty path-backed tabs. Idempotent — the
   * journal is recomputed from scratch, so a saved tab drops out next tick.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.deps.snapshotDirtyBuffers();
    await this.deps.writeJournal(entries);
    if (this.enabled) await this.deps.saveDirtySaved();
  }
}
