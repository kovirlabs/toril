# Design — Windows 11 Install Accuracy + API Key Storage (`fix/windows-install-docs`, `feat/secret-store`)

> Two related pieces of shippable-quality work, requested together. **Part A** corrects
> the Windows 11 install and build instructions and pins the installer behavior they
> promise. **Part B** builds the first real secret storage in Toril — OS-keychain-backed
> API key handling — ahead of the AI layer (ROADMAP Movement IV) that will consume it.
>
> Part B is a **data-safety-adjacent** feature. Its single hard constraint: an API key
> must **never** cross into the webview (CLAUDE.md §3.3 already treats webview content as
> untrusted).

- **Date:** 2026-07-27
- **Branches:** `fix/windows-install-docs`, then `feat/secret-store`
- **Status:** approved design → implementation

---

## 0. Context: why this design exists at all

The original request was to "revise the `.env` file and API key calls to pull from system
environment variables." **Toril has neither.** A tree-wide grep for `api[_-]?key`,
`ANTHROPIC`, `OPENAI`, `dotenv`, `process.env`, `std::env::var`, `import.meta.env`, and
`sops` returns exactly two categories of hit:

- `vite.config.ts:5` — `process.env.TAURI_DEV_HOST`, a Tauri dev-server variable, not a secret.
- `ROADMAP.md:336` — BYO key as a **planned** feature, Movement IV branch 20, not started.

Nothing in Toril talks to a network today. So there is no `.env` to revise and no key
call to repoint; there is only a greenfield decision about how key storage should work
when Movement IV arrives. This spec makes that decision and builds it.

---

## 1. Goal & non-goals

**Goal (Part A).** A Windows 11 user can go from the releases page to a running editor,
and from a clean checkout to a local build, without hitting an undocumented obstacle. The
behavior the README promises is pinned in `tauri.conf.json` rather than inherited from a
framework default.

**Goal (Part B).** A user can store, replace, and remove an Anthropic or OpenAI API key.
The key is encrypted at rest by the OS, is settable from inside the app with no external
tooling, and is readable only by Rust — never by the webview.

**Non-goals.**

- **No provider calls.** This branch stores keys. Nothing sends an HTTP request to
  Anthropic or OpenAI; that is Movement IV branch 20.
- **No key validation against the provider.** We do not round-trip a test request to
  check the key works. Shape validation only.
- **No Settings modal.** Toril has no settings dialog today; this feature does not
  justify inventing one. A single focused dialog instead (§5.3).
- **No environment-variable or SOPS path.** Considered and rejected (§2).
- **No Ollama key.** Ollama is local and unauthenticated; it needs a host URL, not a
  secret, and that belongs to the branch that calls it.
- **No key sync, export, or backup.** A key lives in one OS keychain on one machine. If
  the user reinstalls, they paste it again.

---

## 2. Decisions (locked)

| Question | Decision | Rationale |
|---|---|---|
| Storage backend | **OS keychain via `keyring`** | Encrypted at rest by DPAPI (Windows) / Keychain (macOS) / Secret Service (Linux). Settable in-app, zero user setup. Already the ROADMAP Movement IV decision. |
| Rejected: system env vars | **No** | A `setx` value is plaintext-readable by any process running as that user, appears in child-process environments and crash dumps, cannot be set from inside the app, and requires a relaunch. |
| Rejected: SOPS | **No** | Built for encrypting secrets committed to a repo for a deployment pipeline. Needs an age/GPG key already on the machine — chicken-and-egg — plus a CLI install. Solves a problem a desktop editor does not have. |
| Frontend read access | **None — no getter command** | The security property comes from the API shape, not the backend. See §4. |
| Providers | **`Anthropic`, `OpenAi`** | Closed enum, not free-text. The N-provider shape costs nothing extra now and avoids reopening the file. |
| In-memory handling | **`zeroize`** | The key transits a Rust `String` on its way to the keychain; scrub it on drop rather than leaving it in freed heap. |
| UI surface | **One "API Keys…" dialog** off the native menu | Smallest thing that delivers the capability; absorbable into a Settings modal later. |
| Install-mode docs | **Pin the config, don't soften the doc** | See §3.3. |

### 2.1 Dependency health (CLAUDE.md §2)

Both new dependencies were checked against crates.io before adoption, not assumed:

| Crate | Version | Last publish | Recent downloads | License | Publisher |
|---|---|---|---|---|---|
| `keyring` | 4.1.5 | 2026-07-14 | 7.08M | MIT OR Apache-2.0 | open-source-cooperative |
| `zeroize` | 1.9.0 | 2026-06-12 | 149M | Apache-2.0 OR MIT | RustCrypto |

Neither is deprecated or yanked at the selected version. Both are pinned in `Cargo.lock`.

---

## 3. Part A — Windows 11 install accuracy

### 3.1 What is already correct

Verified against `src-tauri/tauri.conf.json` and the live `v1.0.0-beta.1` release rather
than taken on trust:

- All six download filenames match the published release assets exactly; all links
  return HTTP 200.
- Per-user install with no administrator prompt, installation into `%LOCALAPPDATA%\Toril`,
  the Desktop-shortcut checkbox, the Apps & features entry, and the uninstaller location
  are all accurate.
- The SmartScreen wording ("Windows protected your PC" → More info → Run anyway) is correct.

These need no change.

### 3.2 What is missing

**Install section.** Four Windows 11 realities are undocumented:

1. **Mark of the Web.** A downloaded `.exe` carries a zone identifier; some
   configurations require Properties → Unblock before it will run.
2. **Smart App Control** (Windows 11 24H2+) can block an unsigned installer *outright*,
   with no "Run anyway" escape — a materially different failure from SmartScreen, and
   currently indistinguishable to a user reading the README.
3. **Default-handler registration.** The installer registers `.md`, `.markdown`, `.html`,
   and `.htm`, but Windows 11 removed the one-click "always use this app" prompt. Making
   Toril the default requires Settings → Apps → Default apps.
4. **Per-user scope.** The install is not visible to other accounts on the same PC.

**Build section.** "Building from source" opens with `pnpm install` but never says to
install Rust, Node, or pnpm. It lists only MSVC and WebView2. Missing: `rustup`, Node LTS,
`corepack enable pnpm`, and the MSVC *Desktop development with C++* workload specifically
(the bare "Build Tools" download does not include it by default).

### 3.3 The `tauri.conf.json` gap

`CLAUDE.md` §9 states that `bundle.windows.webviewInstallMode = "downloadBootstrapper"`
is configured. **`tauri.conf.json` has no `bundle.windows` key at all.** Current behavior
is nonetheless correct, because `downloadBootstrapper` and `installMode: "currentUser"`
are Tauri's defaults.

**Decision: add the explicit config rather than weaken the doc.** Every Windows claim in
the README is currently true by inheritance. A Tauri minor bump that flipped `installMode`
to `both` would silently turn "there is no administrator prompt" into a false statement,
with nothing in the repo pinning it. Four lines of config converts an assumption into a
contract and makes §9 true as written.

```json
"windows": {
  "webviewInstallMode": { "type": "downloadBootstrapper" },
  "nsis": { "installMode": "currentUser" }
}
```

**Verification:** this changes bundling only, so it cannot be proven by the headless
gates. It goes on the on-device list — build an installer, confirm no UAC prompt and
installation into `%LOCALAPPDATA%\Toril`.

---

## 4. Part B — architecture

Three layers, mirroring how `crates/mergemd` (pure, gated) relates to `commands/sync.rs`
(glue, on-device only).

```
src/ui/secrets.ts        ← masked input, "Configured / Not set". Never holds a key.
        │ invoke()
        ▼
commands/secrets.rs      ← 4 commands. Deliberately NO getter.
        │
        ▼
crates/keystore          ← SecretStore trait; OsKeychain + MemoryStore impls.
        │
        ▼
keyring → Credential Manager / Keychain / Secret Service
```

### 4.1 The central invariant

**The webview can learn *whether* a key is set. It can never learn *what* the key is.**

`SecretStore::get()` exists on the trait, because Movement IV's provider calls will need
it — from Rust. It is never registered with `invoke_handler`. The registration site
carries a comment saying so, because the natural instinct of the next contributor is to
add the getter for a "show key" toggle.

This is what makes the design meaningfully safer than the environment-variable approach
originally requested. With `TORIL_ANTHROPIC_API_KEY` set, the key is readable by every
process running as that user, *and* would have to be handed to whichever layer issues the
HTTP call. Keeping `get()` Rust-only means a future sanitizer bypass — the exact threat
§3.3 already assumes exists — degrades to "bad DOM" rather than "stolen credential."

### 4.2 `crates/keystore`

Ninth logic crate; a workspace member, webview-free, no Tauri dependency.

```rust
pub enum Provider { Anthropic, OpenAi }   // closed enum, not free-text

pub trait SecretStore {
    fn set(&self, provider: Provider, secret: &str) -> Result<(), KeystoreError>;
    fn get(&self, provider: Provider) -> Result<Option<Zeroizing<String>>, KeystoreError>;
    fn clear(&self, provider: Provider) -> Result<(), KeystoreError>;
    fn contains(&self, provider: Provider) -> Result<bool, KeystoreError>;
}

pub struct OsKeychain;   // keyring::Entry, service "com.toril.app", account = provider id
pub struct MemoryStore;  // test double
```

**Validation** (rejected before the key ever reaches the keychain):

- Empty or whitespace-only.
- Embedded control characters, `\r`, or `\n` — these would corrupt an HTTP header when
  Movement IV eventually sends the key, so rejecting at entry is the honest place.
- Length outside `8..=1024` bytes — a floor that catches a truncated paste and a ceiling
  that catches pasting a whole file into the field. This guards against user accident,
  not against an attacker, so the bound is deliberately loose rather than provider-specific
  (key formats change; a hard-coded `sk-ant-` prefix check would age badly).

**Error mapping** produces stable, secret-free strings. No error variant ever embeds the
secret value.

`clear()` on an absent key is **idempotent**: it succeeds rather than erroring on
`NoEntry`, so a double-click on Clear is harmless.

### 4.3 Commands (`src-tauri/src/commands/secrets.rs`)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `set_api_key` | `provider, key` | `()` | Validates shape, then writes to the OS keychain. Replaces silently. |
| `clear_api_key` | `provider` | `()` | Idempotent — succeeds when no key is stored. |
| `has_api_key` | `provider` | `bool` | The only read the webview gets. |
| `list_api_keys` | — | `[{provider, configured}]` | Drives the dialog's initial state in one round trip. |

To be added to the CLAUDE.md §5 command table.

### 4.4 Frontend (`src/ui/secrets.ts`)

A dialog opened from the native menu ("API Keys…"), with one row per provider: a masked
input, Save, Clear, and a Configured / Not set indicator fed by `list_api_keys`.

The input is cleared immediately after a successful `set_api_key`. The dialog never
renders a stored key, because the backend cannot supply one.

---

## 5. Data safety (CLAUDE.md §3)

- Secrets are written **only** to the OS keychain. They never enter `session.json`,
  `recovery.json`, `history/`, or any file in the user's vault.
- Secrets never cross the IPC boundary toward the webview (§4.1).
- Secrets never appear in log output or error strings.
- No existing data-safety guarantee is touched: this feature adds no writer, so
  `fsatomic` remains the only thing that writes user files.

---

## 6. Gates

| Gate | Command | Covers |
|---|---|---|
| Keystore core | `cargo test -p keystore` | Validation rules, error mapping, idempotent clear, and the full `SecretStore` contract exercised against `MemoryStore`. Runs anywhere — no desktop session required. |
| Frontend | `tests/secrets.test.ts` | Dialog state driven by `list_api_keys`, masked rendering, input cleared after save, and that no code path reads a key back. |

`-p keystore` is added to the CI matrix and to the command lists in `README.md` and
`CLAUDE.md`, bringing the logic crates to nine.

**What CI cannot cover.** The real keychain round-trip needs a logged-in desktop session
(Credential Manager on Windows, Secret Service/dbus on Linux). GitHub's Linux runners have
no Secret Service, so `OsKeychain` itself is verified **on-device only** — the same class
of gap as the sync-coexistence glue in `main.ts`. This is stated plainly rather than
papered over with a test that would silently skip.

---

## 7. Branch split

`CLAUDE.md` §10 is one milestone per branch, so this lands as two:

1. **`fix/windows-install-docs`** — Part A. README rewrite, `tauri.conf.json` pinning,
   `CLAUDE.md` §9 reconciliation. No test changes; verification is on-device.
2. **`feat/secret-store`** — Part B. New crate, commands, UI, gates, CI matrix entry,
   and CLAUDE.md §5 command-table additions.

---

## 8. On-device verification (added to the existing list)

- Build an installer; confirm no UAC prompt and installation into `%LOCALAPPDATA%\Toril`.
- On a Windows 11 24H2 machine with Smart App Control **on**, confirm the documented
  failure mode matches what actually happens.
- Set a key, restart Toril, confirm `has_api_key` still reports it — proving the value
  survived in Credential Manager rather than in process memory.
- Clear a key, confirm it disappears from Credential Manager (`rundll32.exe
  keymgr.dll,KRShowKeyMgr`) and that Clear pressed twice does not error.
