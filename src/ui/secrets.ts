// API key entry (CLAUDE.md §5, ROADMAP Movement IV).
//
// This module can display *whether* a key is stored, never the key itself: the
// backend exposes no command that returns one, so there is nothing to read back
// even by mistake. The input is write-only — filled by the user, handed to Rust,
// then blanked. Nothing here caches a key in a field, a closure, or the DOM.
import {
  clearApiKey as ipcClearApiKey,
  listApiKeys as ipcListApiKeys,
  setApiKey as ipcSetApiKey,
  type ProviderId,
  type ProviderStatus,
} from "../ipc";

/** Display names, keyed by the wire id Rust uses. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/**
 * The backend surface the dialog needs, injected so the gate runs headlessly
 * without Tauri IPC — the same pattern the history panel uses.
 */
export interface SecretsBackend {
  listApiKeys(): Promise<ProviderStatus[]>;
  setApiKey(provider: ProviderId, key: string): Promise<void>;
  clearApiKey(provider: ProviderId): Promise<void>;
}

const defaultBackend: SecretsBackend = {
  listApiKeys: ipcListApiKeys,
  setApiKey: ipcSetApiKey,
  clearApiKey: ipcClearApiKey,
};

export class SecretsDialog {
  private root: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly backend: SecretsBackend = defaultBackend,
  ) {}

  /** Build the dialog and populate it from the backend's current state. */
  async open(): Promise<void> {
    // Reopening replaces rather than stacks — the menu item is clickable while
    // the dialog is already up.
    this.close();

    const root = document.createElement("div");
    root.className = "secrets-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "API keys");

    const heading = document.createElement("h2");
    heading.textContent = "API keys";
    root.append(heading);

    const blurb = document.createElement("p");
    blurb.className = "secrets-blurb";
    blurb.textContent =
      "Keys are stored in your operating system's keychain, never in your notes. " +
      "Toril cannot show a key back to you once it is saved — replace it by pasting a new one.";
    root.append(blurb);

    this.root = root;
    this.host.append(root);

    for (const status of await this.backend.listApiKeys()) {
      root.append(this.buildRow(status));
    }

    const close = document.createElement("button");
    close.className = "secrets-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    root.append(close);
  }

  /** Remove the dialog. Safe to call when it is not open. */
  close(): void {
    this.root?.remove();
    this.root = null;
  }

  private buildRow(status: ProviderStatus): HTMLElement {
    const row = document.createElement("div");
    row.className = "secrets-row";
    row.dataset.provider = status.provider;

    const label = document.createElement("label");
    label.append(PROVIDER_LABELS[status.provider] ?? status.provider);

    const field = document.createElement("input");
    // Masked: the field is write-only, and a shoulder-surfer should not read a
    // key mid-paste.
    field.type = "password";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.placeholder = "Paste a key to replace the stored one";
    label.append(field);
    row.append(label);

    const save = document.createElement("button");
    save.dataset.action = "save";
    save.textContent = "Save";
    row.append(save);

    const clear = document.createElement("button");
    clear.dataset.action = "clear";
    clear.textContent = "Clear";
    row.append(clear);

    const state = document.createElement("span");
    state.className = "secrets-state";
    row.append(state);

    const render = (configured: boolean): void => {
      state.textContent = configured ? "Configured" : "Not set";
    };
    const fail = (err: unknown): void => {
      // Surface the backend's own message — keystore's errors are written for
      // the user and never contain the key.
      state.textContent = err instanceof Error ? err.message : String(err);
    };
    render(status.configured);

    save.addEventListener("click", () => {
      const key = field.value.trim();
      // An empty field is a no-op, not an error: the user may have opened the
      // dialog to check state rather than to change anything.
      if (key === "") return;
      void this.backend
        .setApiKey(status.provider, key)
        .then(() => {
          field.value = "";
          render(true);
        })
        .catch(fail);
    });

    clear.addEventListener("click", () => {
      void this.backend
        .clearApiKey(status.provider)
        .then(() => {
          field.value = "";
          render(false);
        })
        .catch(fail);
    });

    return row;
  }
}
