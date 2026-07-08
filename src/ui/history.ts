// Version-history panel (CLAUDE.md §4, ROADMAP Movement I.3). Lists a note's
// stored versions, shows a read-only line diff of a version against the current
// buffer, and restores on request. All backend access is injected (a `HistoryPort`
// mapping to the Tauri commands, and a `HistoryHost` for the clock + confirm),
// so the panel's logic is unit-testable in jsdom without the webview — the same
// split the outline panel uses.
import type { SnapshotMeta } from "../ipc";
import { type DiffLine, lineDiff } from "./linediff";

/** Backend operations, injected so the panel is testable without Tauri. */
export interface HistoryPort {
  list(path: string): Promise<SnapshotMeta[]>;
  read(path: string, hash: string): Promise<string>;
  /** Full restore flow (save-if-dirty → restore → reload), owned by the caller. */
  restore(path: string, hash: string): Promise<void>;
}

/** Ambient dependencies (clock + confirmation), injected for determinism. */
export interface HistoryHost {
  now(): number;
  confirm(message: string): boolean;
}

/** Human-friendly age of a timestamp relative to `now` (both epoch millis). */
export function formatRelativeTime(then: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk} w ago`;
  return new Date(then).toLocaleDateString();
}

/** Compact byte-size label ("512 B", "1.4 KB", "2.0 MB"). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export class History {
  private path: string | null = null;
  private current = "";
  private metas: SnapshotMeta[] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly port: HistoryPort,
    private readonly host: HistoryHost,
  ) {}

  /** Point the panel at a note (path + current buffer text); `null` clears it. */
  async setActive(path: string | null, current: string): Promise<void> {
    this.path = path;
    this.current = current;
    await this.refresh();
  }

  /** Re-read the version list for the active note and re-render. */
  async refresh(): Promise<void> {
    this.metas = this.path ? await this.port.list(this.path) : [];
    this.render();
  }

  private render(): void {
    this.el.replaceChildren();
    if (!this.path || this.metas.length === 0) {
      const hint = document.createElement("p");
      hint.className = "history-empty";
      hint.textContent = this.path ? "No versions yet" : "No note open";
      this.el.append(hint);
      return;
    }
    const list = document.createElement("ul");
    list.className = "history-list";
    for (const meta of this.metas) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "history-entry";
      btn.dataset.hash = meta.hash;

      const when = document.createElement("span");
      when.className = "history-when";
      when.textContent = formatRelativeTime(meta.saved_at, this.host.now());
      const size = document.createElement("span");
      size.className = "history-size";
      size.textContent = formatSize(meta.size);

      btn.append(when, size);
      btn.addEventListener("click", () => void this.select(meta.hash));
      li.append(btn);
      list.append(li);
    }
    this.el.append(list);
  }

  /** Load a version and show its diff vs the current buffer. */
  private async select(hash: string): Promise<void> {
    if (!this.path) return;
    const snapshot = await this.port.read(this.path, hash);
    this.renderDiff(hash, lineDiff(snapshot, this.current));
  }

  private renderDiff(hash: string, rows: DiffLine[]): void {
    const view = document.createElement("div");
    view.className = "history-diff";
    view.dataset.hash = hash;

    const pre = document.createElement("pre");
    pre.className = "history-diff-body";
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "history-diff-line";
      line.dataset.op = row.op;
      const mark = row.op === "add" ? "+" : row.op === "del" ? "-" : " ";
      line.textContent = `${mark} ${row.text}`;
      pre.append(line);
    }

    const restore = document.createElement("button");
    restore.className = "history-restore";
    restore.textContent = "Restore this version";
    restore.addEventListener("click", () => void this.doRestore(hash));

    view.append(pre, restore);
    this.el.append(view);
  }

  private async doRestore(hash: string): Promise<void> {
    if (!this.path) return;
    if (!this.host.confirm("Restore this version? Your current text is saved to history first.")) {
      return;
    }
    await this.port.restore(this.path, hash);
    await this.refresh();
  }
}
