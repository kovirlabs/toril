// Gate for the API keys dialog (CLAUDE.md §8, ROADMAP Movement IV).
//
// The behavior worth pinning is not "the form works" — it is that the dialog
// can never display a key. It has no way to fetch one (there is no getter
// command), the field is write-only, and it is blanked after a successful
// save. These tests fail if any of that regresses.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderId, ProviderStatus } from "../src/ipc";
import { PROVIDER_LABELS, SecretsDialog } from "../src/ui/secrets";

function makeBackend(initial: ProviderStatus[]) {
  const state = new Map<ProviderId, boolean>(
    initial.map((s) => [s.provider, s.configured]),
  );
  return {
    state,
    listApiKeys: vi.fn(async (): Promise<ProviderStatus[]> =>
      [...state].map(([provider, configured]) => ({ provider, configured })),
    ),
    setApiKey: vi.fn(async (provider: ProviderId, _key: string): Promise<void> => {
      state.set(provider, true);
    }),
    clearApiKey: vi.fn(async (provider: ProviderId): Promise<void> => {
      state.set(provider, false);
    }),
  };
}

function row(provider: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-provider="${provider}"]`);
  if (!el) throw new Error(`no row for ${provider}`);
  return el;
}

function input(provider: string): HTMLInputElement {
  const el = row(provider).querySelector("input");
  if (!el) throw new Error(`no input for ${provider}`);
  return el;
}

function button(provider: string, action: string): HTMLButtonElement {
  const el = row(provider).querySelector<HTMLButtonElement>(
    `button[data-action="${action}"]`,
  );
  if (!el) throw new Error(`no ${action} button for ${provider}`);
  return el;
}

describe("SecretsDialog", () => {
  beforeEach(() => {
    // replaceChildren rather than innerHTML = "": this repo treats innerHTML as
    // a §3.3 smell, and there is no reason for a test to model the bad habit.
    document.body.replaceChildren();
  });

  it("renders one labelled row per provider", async () => {
    const backend = makeBackend([
      { provider: "anthropic", configured: false },
      { provider: "openai", configured: false },
    ]);

    await new SecretsDialog(document.body, backend).open();

    expect(document.querySelectorAll("[data-provider]")).toHaveLength(2);
    expect(document.body.textContent).toContain(PROVIDER_LABELS.anthropic);
    expect(document.body.textContent).toContain(PROVIDER_LABELS.openai);
  });

  it("takes configured state from the backend rather than a cached key", async () => {
    const backend = makeBackend([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: false },
    ]);

    await new SecretsDialog(document.body, backend).open();

    expect(row("anthropic").textContent).toContain("Configured");
    expect(row("openai").textContent).toContain("Not set");
  });

  it("masks the field so a key is never rendered in plain text", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);

    await new SecretsDialog(document.body, backend).open();

    expect(input("anthropic").type).toBe("password");
  });

  it("saves a key and blanks the field afterwards", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    await new SecretsDialog(document.body, backend).open();

    input("anthropic").value = "sk-ant-abcdefgh";
    button("anthropic", "save").click();

    await vi.waitFor(() =>
      expect(backend.setApiKey).toHaveBeenCalledWith("anthropic", "sk-ant-abcdefgh"),
    );
    // The key must not linger in the DOM once it is stored.
    await vi.waitFor(() => expect(input("anthropic").value).toBe(""));
    expect(row("anthropic").textContent).toContain("Configured");
  });

  it("clears a key and reflects the new state", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: true }]);
    await new SecretsDialog(document.body, backend).open();

    button("anthropic", "clear").click();

    await vi.waitFor(() =>
      expect(backend.clearApiKey).toHaveBeenCalledWith("anthropic"),
    );
    await vi.waitFor(() => expect(row("anthropic").textContent).toContain("Not set"));
  });

  it("surfaces a backend rejection instead of claiming success", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    backend.setApiKey.mockRejectedValueOnce(
      new Error("the API key contains a line break or control character"),
    );
    await new SecretsDialog(document.body, backend).open();

    input("anthropic").value = "bad\nkey";
    button("anthropic", "save").click();

    await vi.waitFor(() =>
      expect(row("anthropic").textContent).toContain("line break or control character"),
    );
    expect(row("anthropic").textContent).not.toContain("Configured");
  });

  it("does not call the backend with an empty field", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    await new SecretsDialog(document.body, backend).open();

    input("anthropic").value = "   ";
    button("anthropic", "save").click();
    await Promise.resolve();

    expect(backend.setApiKey).not.toHaveBeenCalled();
  });

  it("removes itself from the DOM on close", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    const dialog = new SecretsDialog(document.body, backend);
    await dialog.open();

    dialog.close();

    expect(document.querySelector("[data-provider]")).toBeNull();
  });

  it("does not stack duplicate dialogs when opened twice", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    const dialog = new SecretsDialog(document.body, backend);

    await dialog.open();
    await dialog.open();

    expect(document.querySelectorAll("[data-provider]")).toHaveLength(1);
  });
});
