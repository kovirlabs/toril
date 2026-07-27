# Windows 11 Install Accuracy + API Key Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct Toril's Windows 11 install/build instructions and pin the installer behavior they promise, then build OS-keychain-backed API key storage ahead of the AI layer that will consume it.

**Architecture:** Part A is documentation plus four lines of `tauri.conf.json`. Part B adds a ninth logic crate (`crates/keystore`) wrapping the `keyring` crate behind a `SecretStore` trait with an in-memory test double, four thin Tauri commands, and one focused dialog. The load-bearing decision is that no command returns a key — `get()` is Rust-only, so a secret never crosses into the webview.

**Tech Stack:** Rust (edition 2024), `keyring` 4.1.5, `zeroize` 1.9.0, Tauri 2, TypeScript strict, vitest.

**Design:** `docs/superpowers/specs/2026-07-27-windows-install-and-secret-store-design.md`

## Global Constraints

- **No getter command.** `SecretStore::get()` is never registered with `invoke_handler`. The webview learns *whether* a key is set, never *what* it is.
- **Secrets never leave the keychain.** Never written to `session.json`, `recovery.json`, `history/`, or any vault file. Never logged. Never embedded in an error string.
- Rust edition 2024; `cargo fmt --all` and `cargo clippy` clean before commit (CLAUDE.md §10).
- TypeScript `strict`; no `any`.
- Dependencies pinned; `Cargo.lock` committed (§2). `keyring = "4.1.5"`, `zeroize = "1.9.0"`.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Providers are a **closed enum**: `Anthropic`, `OpenAi`. No free-text provider ids.
- Key validation: reject empty/whitespace-only, reject control chars/`\r`/`\n`, require length in `8..=1024` bytes.
- `clear()` is idempotent — succeeds when no key is stored.

---

# Part A — `fix/windows-install-docs`

### Task 1: Pin the Windows installer behavior

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`bundle` object)
- Modify: `CLAUDE.md` §9

**Interfaces:**
- Consumes: nothing.
- Produces: a `bundle.windows` object whose values the README in Task 2 documents as guarantees.

- [ ] **Step 1: Add the explicit `bundle.windows` block**

In `src-tauri/tauri.conf.json`, inside `"bundle"`, after the `"targets"` array:

```json
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" },
      "nsis": { "installMode": "currentUser" }
    },
```

These are Tauri's current defaults. Setting them explicitly is the point: the README promises a per-user install with no admin prompt, and that promise currently rests on an inherited default a minor bump could change.

- [ ] **Step 2: Verify the config still parses**

Run: `cd src-tauri && python3 -c "import json;json.load(open('tauri.conf.json'));print('ok')"`
Expected: `ok`

- [ ] **Step 3: Reconcile CLAUDE.md §9**

§9 currently asserts `bundle.windows.webviewInstallMode = "downloadBootstrapper"` is set, which was untrue. Update the sentence to also record `nsis.installMode`, and note why both are explicit:

```markdown
`bundle.windows.webviewInstallMode = "downloadBootstrapper"` (handles Win10 WebView2)
and `bundle.windows.nsis.installMode = "currentUser"` (per-user install, no UAC prompt).
Both match Tauri's current defaults and are set **explicitly on purpose** — the README
documents them as user-facing guarantees, so they must not silently change under a
framework upgrade.
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json CLAUDE.md
git commit -m "fix(bundle): pin NSIS installMode and WebView2 install mode explicitly"
```

---

### Task 2: Rewrite the Windows 11 install and build instructions

**Files:**
- Modify: `README.md` — the `<details><summary><b>Installing on Windows</b></summary>` block and the "Building from source" section.

**Interfaces:**
- Consumes: the `bundle.windows` config from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the Windows install block with numbered steps**

Replace the existing `<details>` block for Windows with:

````markdown
<details>
<summary><b>Installing on Windows</b></summary>

**1. Download** `Toril_1.0.0-beta.1_x64-setup.exe` from the releases page.

**2. Unblock it if Windows marked it.** Files downloaded from the internet carry a
"mark of the web". If the installer refuses to start, right-click it →
**Properties** → tick **Unblock** at the bottom → **OK**.

**3. Run the installer.** It installs per-user, so there is no administrator
prompt. It copies the app into `%LOCALAPPDATA%\Toril`, adds a Start Menu entry,
offers a Desktop shortcut, and registers in **Apps & features** for clean
uninstallation. Because the install is per-user, other accounts on the same PC
will not see Toril.

**4. Get past the unsigned-build warning.** The build is not code-signed, so
Windows objects on first run. Which warning you get depends on your settings:

- **SmartScreen** — "Windows protected your PC". Choose **More info → Run
  anyway**.
- **Smart App Control** (Windows 11 24H2 and later, on clean installs) — this one
  *blocks* the installer outright and offers no "Run anyway". If you hit it, you
  must turn Smart App Control off in **Windows Security → App & browser control
  → Smart App Control settings** to install. Note that turning it off is
  permanent until you reinstall Windows, so decide deliberately.

Both are expected for an unsigned build, not a sign of a problem. Signed
installers are on the roadmap.

**5. Optional — make Toril your default Markdown editor.** The installer
registers `.md`, `.markdown`, `.html`, and `.htm`, but Windows 11 no longer
offers a one-click "always use this app" prompt. To set it: **Settings → Apps →
Default apps** → search for `Toril` → pick each file type you want it to own.
You can also right-click any `.md` file → **Open with → Choose another app**.

**To uninstall:** **Settings → Apps → Installed apps → Toril → Uninstall**, or
run the uninstaller in `%LOCALAPPDATA%\Toril`.

</details>
````

- [ ] **Step 2: Add the missing build prerequisites**

The "Building from source" section currently opens with `pnpm install` without ever saying to install Rust, Node, or pnpm. Replace the `Platform build dependencies:` list's Windows entry and add a prerequisites block above the code fence:

````markdown
You need these first, on every platform:

- **Rust** (stable) via [rustup](https://rustup.rs).
- **Node.js** LTS.
- **pnpm**, enabled through Corepack: `corepack enable pnpm`.

Then:

```bash
pnpm install
pnpm tauri dev      # run with hot reload
pnpm tauri build    # produce installers
```

The first run compiles the Rust backend and takes a while; later runs are fast.

Platform build dependencies:

- **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the **Desktop development with C++** workload selected — the default
  download does not include it, and without it the Rust link step fails. Plus the
  WebView2 runtime, which is preinstalled on Windows 11 and bootstrapped by the
  installer on Windows 10.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux:**
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): correct and expand the Windows 11 install and build steps"
```

---

# Part B — `feat/secret-store`

### Task 3: `crates/keystore` — validation and the in-memory store

**Files:**
- Create: `src-tauri/crates/keystore/Cargo.toml`
- Create: `src-tauri/crates/keystore/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (workspace `members`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Provider` (`Anthropic`, `OpenAi`) with `as_str()`/`FromStr`; `KeystoreError`; `validate_secret(&str) -> Result<(), KeystoreError>`; `SecretStore` trait with `set`/`get`/`clear`/`contains`; `MemoryStore::new()`. Task 4 adds `OsKeychain`; Task 5's commands consume `Provider`, `KeystoreError`, and the trait.

- [ ] **Step 1: Create the crate manifest**

`src-tauri/crates/keystore/Cargo.toml`:

```toml
[package]
name = "keystore"
version = "0.1.0"
edition = "2024"
description = "OS-keychain-backed API key storage for Toril (CLAUDE.md §3, ROADMAP Movement IV). A SecretStore trait over the platform keychain, plus an in-memory double so the contract is testable without a desktop session. No Tauri dep."

# Both vetted against crates.io before adoption (§2): keyring 4.1.5 (published
# 2026-07-14, 7.08M recent downloads, open-source-cooperative) and zeroize 1.9.0
# (RustCrypto, 149M recent downloads). Neither deprecated nor yanked.
# keyring 4.x `default = ["v1"]` already selects the Apple Keychain,
# Windows-native, and zbus Secret Service backends. (The explicit
# `apple-native` / `windows-native` / `sync-secret-service` flags are 3.x names
# and do not exist here.)
[dependencies]
keyring = "4.1.5"
zeroize = "1.9.0"
```

Add `"crates/keystore"` to the `members` list in `src-tauri/Cargo.toml`.

- [ ] **Step 2: Write the failing tests**

`src-tauri/crates/keystore/src/lib.rs`, tests module only for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_round_trip() {
        for p in [Provider::Anthropic, Provider::OpenAi] {
            assert_eq!(p.as_str().parse::<Provider>().unwrap(), p);
        }
    }

    #[test]
    fn unknown_provider_id_is_rejected() {
        assert!("pineapple".parse::<Provider>().is_err());
    }

    #[test]
    fn rejects_empty_and_whitespace_only_secrets() {
        assert!(matches!(validate_secret(""), Err(KeystoreError::EmptySecret)));
        assert!(matches!(
            validate_secret("      \t  "),
            Err(KeystoreError::EmptySecret)
        ));
    }

    #[test]
    fn rejects_control_characters() {
        // A newline here would corrupt an HTTP header once Movement IV sends it.
        assert!(matches!(
            validate_secret("sk-ant-abc\ndef"),
            Err(KeystoreError::InvalidCharacter)
        ));
        assert!(matches!(
            validate_secret("sk-ant-abc\rdef"),
            Err(KeystoreError::InvalidCharacter)
        ));
        assert!(matches!(
            validate_secret("sk-ant-a\u{0}bc"),
            Err(KeystoreError::InvalidCharacter)
        ));
    }

    #[test]
    fn enforces_length_bounds() {
        assert!(matches!(
            validate_secret("short"),
            Err(KeystoreError::BadLength)
        ));
        assert!(matches!(
            validate_secret(&"x".repeat(1025)),
            Err(KeystoreError::BadLength)
        ));
        assert!(validate_secret(&"x".repeat(8)).is_ok());
        assert!(validate_secret(&"x".repeat(1024)).is_ok());
    }

    #[test]
    fn error_messages_never_contain_the_secret() {
        let secret = "sk-ant-supersecretvalue";
        let err = validate_secret(&format!("{secret}\n")).unwrap_err();
        assert!(!err.to_string().contains(secret));
    }

    #[test]
    fn set_then_contains_then_get() {
        let store = MemoryStore::new();
        assert!(!store.contains(Provider::Anthropic).unwrap());

        store.set(Provider::Anthropic, "sk-ant-abcdefgh").unwrap();

        assert!(store.contains(Provider::Anthropic).unwrap());
        assert_eq!(
            store.get(Provider::Anthropic).unwrap().as_deref(),
            Some("sk-ant-abcdefgh")
        );
    }

    #[test]
    fn providers_do_not_collide() {
        let store = MemoryStore::new();
        store.set(Provider::Anthropic, "sk-ant-abcdefgh").unwrap();

        assert!(!store.contains(Provider::OpenAi).unwrap());
        assert_eq!(store.get(Provider::OpenAi).unwrap().as_deref(), None);
    }

    #[test]
    fn set_replaces_an_existing_secret() {
        let store = MemoryStore::new();
        store.set(Provider::Anthropic, "sk-ant-firstvalue").unwrap();
        store.set(Provider::Anthropic, "sk-ant-secondvalue").unwrap();

        assert_eq!(
            store.get(Provider::Anthropic).unwrap().as_deref(),
            Some("sk-ant-secondvalue")
        );
    }

    #[test]
    fn clear_is_idempotent() {
        let store = MemoryStore::new();
        store.set(Provider::Anthropic, "sk-ant-abcdefgh").unwrap();

        store.clear(Provider::Anthropic).unwrap();
        // Pressing Clear twice must not error.
        store.clear(Provider::Anthropic).unwrap();

        assert!(!store.contains(Provider::Anthropic).unwrap());
    }

    #[test]
    fn set_rejects_an_invalid_secret_without_storing_it() {
        let store = MemoryStore::new();
        assert!(store.set(Provider::Anthropic, "bad\nkey").is_err());
        assert!(!store.contains(Provider::Anthropic).unwrap());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p keystore`
Expected: FAIL — `cannot find type Provider in this scope` and similar.

- [ ] **Step 4: Implement validation, `Provider`, the trait, and `MemoryStore`**

Prepend to `src-tauri/crates/keystore/src/lib.rs`:

```rust
//! OS-keychain-backed API key storage (CLAUDE.md §3, ROADMAP Movement IV).
//!
//! The security property here comes from the **API shape**, not the backend.
//! `get` exists so Rust-side provider calls can use a key; it is deliberately
//! never exposed as a Tauri command, so a secret cannot cross into the webview
//! — which §3.3 already treats as untrusted. See `commands/secrets.rs`.
//!
//! Split as a workspace crate so the contract is unit-testable without a
//! desktop session: every test here runs against `MemoryStore`. `OsKeychain`
//! itself is verified on-device only (no Secret Service on CI Linux runners).

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Mutex;

use zeroize::Zeroizing;

/// Providers that require an API key. A closed enum, not a free-text id, so a
/// typo cannot silently create an orphaned keychain entry.
///
/// Ollama is absent on purpose: it is local and unauthenticated, and needs a
/// host URL rather than a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Anthropic,
    OpenAi,
}

impl Provider {
    /// Stable wire id — also the keychain *account* name, so renaming a variant
    /// must not change this without a migration.
    pub const fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
        }
    }

    /// Every provider, for `list_api_keys`.
    pub const ALL: [Provider; 2] = [Provider::Anthropic, Provider::OpenAi];
}

impl FromStr for Provider {
    type Err = KeystoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "anthropic" => Ok(Provider::Anthropic),
            "openai" => Ok(Provider::OpenAi),
            _ => Err(KeystoreError::UnknownProvider),
        }
    }
}

/// Failure modes, mapped to stable strings.
///
/// No variant carries the secret value, and `Backend` carries only the
/// platform's message — never the key. `error_messages_never_contain_the_secret`
/// pins that.
#[derive(Debug, PartialEq, Eq)]
pub enum KeystoreError {
    UnknownProvider,
    EmptySecret,
    InvalidCharacter,
    BadLength,
    Backend(String),
}

impl fmt::Display for KeystoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeystoreError::UnknownProvider => write!(f, "unknown provider"),
            KeystoreError::EmptySecret => write!(f, "the API key is empty"),
            KeystoreError::InvalidCharacter => write!(
                f,
                "the API key contains a line break or control character — check for a stray newline in what you pasted"
            ),
            KeystoreError::BadLength => write!(
                f,
                "the API key must be between {MIN_SECRET_LEN} and {MAX_SECRET_LEN} characters"
            ),
            KeystoreError::Backend(msg) => write!(f, "the system keychain refused the request: {msg}"),
        }
    }
}

impl std::error::Error for KeystoreError {}

/// Lower bound catches a truncated paste; upper bound catches pasting a whole
/// file into the field. Deliberately loose and provider-agnostic — a hard-coded
/// `sk-ant-` prefix check would age badly as key formats change.
const MIN_SECRET_LEN: usize = 8;
const MAX_SECRET_LEN: usize = 1024;

/// Reject a secret that cannot be stored or later sent as an HTTP header.
pub fn validate_secret(secret: &str) -> Result<(), KeystoreError> {
    if secret.trim().is_empty() {
        return Err(KeystoreError::EmptySecret);
    }
    if secret.chars().any(char::is_control) {
        return Err(KeystoreError::InvalidCharacter);
    }
    if !(MIN_SECRET_LEN..=MAX_SECRET_LEN).contains(&secret.len()) {
        return Err(KeystoreError::BadLength);
    }
    Ok(())
}

/// Storage backend for provider secrets.
///
/// `get` returns `Zeroizing<String>` so the copy in our address space is
/// overwritten on drop rather than left in freed heap.
pub trait SecretStore {
    fn set(&self, provider: Provider, secret: &str) -> Result<(), KeystoreError>;
    fn get(&self, provider: Provider) -> Result<Option<Zeroizing<String>>, KeystoreError>;
    fn clear(&self, provider: Provider) -> Result<(), KeystoreError>;
    fn contains(&self, provider: Provider) -> Result<bool, KeystoreError>;
}

/// In-memory double. Exists so the `SecretStore` contract has a gate that runs
/// on any machine; never used by the app itself.
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<Provider, String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemoryStore {
    fn set(&self, provider: Provider, secret: &str) -> Result<(), KeystoreError> {
        validate_secret(secret)?;
        let mut entries = self.entries.lock().expect("keystore mutex poisoned");
        entries.insert(provider, secret.to_owned());
        Ok(())
    }

    fn get(&self, provider: Provider) -> Result<Option<Zeroizing<String>>, KeystoreError> {
        let entries = self.entries.lock().expect("keystore mutex poisoned");
        Ok(entries.get(&provider).cloned().map(Zeroizing::new))
    }

    fn clear(&self, provider: Provider) -> Result<(), KeystoreError> {
        let mut entries = self.entries.lock().expect("keystore mutex poisoned");
        entries.remove(&provider);
        Ok(())
    }

    fn contains(&self, provider: Provider) -> Result<bool, KeystoreError> {
        let entries = self.entries.lock().expect("keystore mutex poisoned");
        Ok(entries.contains_key(&provider))
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test -p keystore`
Expected: PASS, 11 tests.

- [ ] **Step 6: Format, lint, and commit**

```bash
cd src-tauri && cargo fmt --all && cargo clippy -p keystore --all-targets
cd .. && git add src-tauri/crates/keystore src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(keystore): add secret validation and the in-memory store"
```

---

### Task 4: `OsKeychain` — the platform-backed store

**Files:**
- Modify: `src-tauri/crates/keystore/src/lib.rs`

**Interfaces:**
- Consumes: `Provider`, `KeystoreError`, `SecretStore`, `validate_secret` from Task 3.
- Produces: `OsKeychain::new()` and `SERVICE`. Task 5 constructs `OsKeychain` in each command.

- [ ] **Step 1: Implement `OsKeychain`**

Append to `src-tauri/crates/keystore/src/lib.rs`, above the tests module:

```rust
/// Keychain *service* name. Matches the app identifier in `tauri.conf.json`;
/// the *account* is `Provider::as_str()`. Changing either orphans stored keys.
pub const SERVICE: &str = "com.toril.app";

/// The real store: Windows Credential Manager, macOS Keychain, or the
/// freedesktop Secret Service on Linux.
///
/// Not covered by `cargo test -p keystore` — it needs a logged-in desktop
/// session, and CI's Linux runners have no Secret Service. Verified on-device
/// (see the design doc §8). The `MemoryStore` tests pin the contract this is
/// expected to honor.
pub struct OsKeychain;

impl OsKeychain {
    pub fn new() -> Self {
        Self
    }

    fn entry(provider: Provider) -> Result<keyring::Entry, KeystoreError> {
        keyring::Entry::new(SERVICE, provider.as_str())
            .map_err(|e| KeystoreError::Backend(e.to_string()))
    }
}

impl Default for OsKeychain {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for OsKeychain {
    fn set(&self, provider: Provider, secret: &str) -> Result<(), KeystoreError> {
        validate_secret(secret)?;
        Self::entry(provider)?
            .set_password(secret)
            .map_err(|e| KeystoreError::Backend(e.to_string()))
    }

    fn get(&self, provider: Provider) -> Result<Option<Zeroizing<String>>, KeystoreError> {
        match Self::entry(provider)?.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(KeystoreError::Backend(e.to_string())),
        }
    }

    fn clear(&self, provider: Provider) -> Result<(), KeystoreError> {
        // Idempotent: a missing entry is the desired end state, not a failure.
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(KeystoreError::Backend(e.to_string())),
        }
    }

    fn contains(&self, provider: Provider) -> Result<bool, KeystoreError> {
        Ok(self.get(provider)?.is_some())
    }
}
```

- [ ] **Step 2: Verify the crate still builds and tests pass**

Run: `cd src-tauri && cargo test -p keystore`
Expected: PASS, same 11 tests. (No new tests — `OsKeychain` is on-device only, by design.)

- [ ] **Step 3: Format, lint, and commit**

```bash
cd src-tauri && cargo fmt --all && cargo clippy -p keystore --all-targets
cd .. && git add src-tauri/crates/keystore src-tauri/Cargo.lock
git commit -m "feat(keystore): add the OS keychain backend"
```

---

### Task 5: Tauri commands

**Files:**
- Create: `src-tauri/src/commands/secrets.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs` (`invoke_handler`)
- Modify: `src-tauri/Cargo.toml` (app `[dependencies]`)

**Interfaces:**
- Consumes: `Provider`, `OsKeychain`, `SecretStore`, `KeystoreError` from Tasks 3–4.
- Produces: commands `set_api_key(provider, key)`, `clear_api_key(provider)`, `has_api_key(provider) -> bool`, `list_api_keys() -> Vec<ProviderStatus>` where `ProviderStatus { provider: String, configured: bool }` serializes camelCase. Task 6's `ipc.ts` mirrors these exactly.

- [ ] **Step 1: Add the crate to the app's dependencies**

In `src-tauri/Cargo.toml` `[dependencies]`, after `mergemd`:

```toml
keystore = { path = "crates/keystore" }
```

- [ ] **Step 2: Write the command module**

`src-tauri/src/commands/secrets.rs`:

```rust
//! API key storage (CLAUDE.md §5, ROADMAP Movement IV).
//!
//! **There is deliberately no `get_api_key` command, and there must never be
//! one.** `keystore::SecretStore::get` exists for Rust-side provider calls; the
//! webview only ever learns *whether* a key is set. §3.3 already treats webview
//! content as untrusted, so a key that never crosses the IPC boundary turns a
//! future sanitizer bypass into a rendering bug rather than a stolen credential.
//! A "show key" toggle is not worth reversing that.

use keystore::{OsKeychain, Provider, SecretStore};
use serde::Serialize;

/// Whether one provider has a key stored. Never carries the key itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub configured: bool,
}

fn parse(provider: &str) -> Result<Provider, String> {
    provider.parse::<Provider>().map_err(|e| e.to_string())
}

/// Validate and store a key, replacing any existing one for that provider.
#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    OsKeychain::new()
        .set(parse(&provider)?, &key)
        .map_err(|e| e.to_string())
}

/// Remove a stored key. Idempotent — clearing an absent key succeeds.
#[tauri::command]
pub fn clear_api_key(provider: String) -> Result<(), String> {
    OsKeychain::new()
        .clear(parse(&provider)?)
        .map_err(|e| e.to_string())
}

/// Whether a key is stored. The only read the webview is permitted.
#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    OsKeychain::new()
        .contains(parse(&provider)?)
        .map_err(|e| e.to_string())
}

/// Status of every provider, so the dialog can render in one round trip.
#[tauri::command]
pub fn list_api_keys() -> Result<Vec<ProviderStatus>, String> {
    let store = OsKeychain::new();
    Provider::ALL
        .iter()
        .map(|&p| {
            store
                .contains(p)
                .map(|configured| ProviderStatus {
                    provider: p.as_str().to_owned(),
                    configured,
                })
                .map_err(|e| e.to_string())
        })
        .collect()
}
```

- [ ] **Step 3: Register the module and the commands**

Add `pub mod secrets;` to `src-tauri/src/commands/mod.rs` (alphabetical — after `recovery`).

In `src-tauri/src/lib.rs`, inside `generate_handler![`, after `commands::sync::write_conflict_copy,`:

```rust
            // No `get_api_key` — by design. A stored key must never cross into
            // the webview; see commands/secrets.rs.
            commands::secrets::set_api_key,
            commands::secrets::clear_api_key,
            commands::secrets::has_api_key,
            commands::secrets::list_api_keys,
```

- [ ] **Step 4: Verify the app crate compiles**

Run: `cd src-tauri && cargo check`
Expected: no errors. (The dev box has the WebKitGTK deps per CLAUDE.md §0, so this links.)

- [ ] **Step 5: Format, lint, and commit**

```bash
cd src-tauri && cargo fmt --all && cargo clippy
cd .. && git add src-tauri/src src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(secrets): add API key commands with no getter by design"
```

---

### Task 6: Frontend IPC wrappers and the API Keys dialog

**Files:**
- Modify: `src/ipc.ts`
- Create: `src/ui/secrets.ts`
- Create: `tests/secrets.test.ts`

**Interfaces:**
- Consumes: the four commands from Task 5.
- Produces: `ProviderId = "anthropic" | "openai"`, `ProviderStatus`, `setApiKey`, `clearApiKey`, `listApiKeys` in `ipc.ts`; `SecretsDialog` class in `src/ui/secrets.ts` with `open()` and `close()`. Task 7 wires the menu to `open()`.

- [ ] **Step 1: Add the IPC wrappers**

Append to `src/ipc.ts`:

```typescript
/** Providers that take an API key (mirrors Rust `keystore::Provider`). */
export type ProviderId = "anthropic" | "openai";

/** Whether one provider has a key stored (mirrors Rust `ProviderStatus`). */
export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
}

/**
 * Store an API key in the OS keychain.
 *
 * There is deliberately no `getApiKey`: the backend exposes no command that
 * returns a key, so this module cannot read one back (§3.3, ROADMAP IV).
 */
export function setApiKey(provider: ProviderId, key: string): Promise<void> {
  return invoke<void>("set_api_key", { provider, key });
}

/** Remove a stored key. Succeeds even if none was stored. */
export function clearApiKey(provider: ProviderId): Promise<void> {
  return invoke<void>("clear_api_key", { provider });
}

/** Configured/not-set status for every provider. */
export function listApiKeys(): Promise<ProviderStatus[]> {
  return invoke<ProviderStatus[]>("list_api_keys");
}
```

- [ ] **Step 2: Write the failing tests**

`tests/secrets.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_LABELS, SecretsDialog } from "../src/ui/secrets";
import type { ProviderStatus } from "../src/ipc";

function makeBackend(initial: ProviderStatus[]) {
  const state = new Map(initial.map((s) => [s.provider, s.configured]));
  return {
    state,
    listApiKeys: vi.fn(async () =>
      [...state].map(([provider, configured]) => ({ provider, configured }) as ProviderStatus),
    ),
    setApiKey: vi.fn(async (provider: string, _key: string) => {
      state.set(provider as ProviderStatus["provider"], true);
    }),
    clearApiKey: vi.fn(async (provider: string) => {
      state.set(provider as ProviderStatus["provider"], false);
    }),
  };
}

describe("SecretsDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one row per provider, labelled", async () => {
    const backend = makeBackend([
      { provider: "anthropic", configured: false },
      { provider: "openai", configured: false },
    ]);
    const dialog = new SecretsDialog(document.body, backend);

    await dialog.open();

    const rows = document.querySelectorAll("[data-provider]");
    expect(rows).toHaveLength(2);
    expect(document.body.textContent).toContain(PROVIDER_LABELS.anthropic);
    expect(document.body.textContent).toContain(PROVIDER_LABELS.openai);
  });

  it("shows configured state from the backend, not from a cached key", async () => {
    const backend = makeBackend([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: false },
    ]);
    const dialog = new SecretsDialog(document.body, backend);

    await dialog.open();

    expect(row("anthropic").textContent).toContain("Configured");
    expect(row("openai").textContent).toContain("Not set");
  });

  it("masks the input so a key is never rendered in plain text", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    const dialog = new SecretsDialog(document.body, backend);

    await dialog.open();

    expect(input("anthropic").type).toBe("password");
  });

  it("saves a key and clears the field afterwards", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    const dialog = new SecretsDialog(document.body, backend);
    await dialog.open();

    input("anthropic").value = "sk-ant-abcdefgh";
    button("anthropic", "save").click();
    await vi.waitFor(() => expect(backend.setApiKey).toHaveBeenCalled());

    expect(backend.setApiKey).toHaveBeenCalledWith("anthropic", "sk-ant-abcdefgh");
    // The key must not linger in the DOM after a successful save.
    expect(input("anthropic").value).toBe("");
    await vi.waitFor(() => expect(row("anthropic").textContent).toContain("Configured"));
  });

  it("clears a key and reflects the new state", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: true }]);
    const dialog = new SecretsDialog(document.body, backend);
    await dialog.open();

    button("anthropic", "clear").click();
    await vi.waitFor(() => expect(backend.clearApiKey).toHaveBeenCalledWith("anthropic"));
    await vi.waitFor(() => expect(row("anthropic").textContent).toContain("Not set"));
  });

  it("surfaces a backend rejection instead of claiming success", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    backend.setApiKey.mockRejectedValueOnce(
      new Error("the API key contains a line break or control character"),
    );
    const dialog = new SecretsDialog(document.body, backend);
    await dialog.open();

    input("anthropic").value = "bad\nkey";
    button("anthropic", "save").click();

    await vi.waitFor(() =>
      expect(row("anthropic").textContent).toContain("line break or control character"),
    );
    expect(row("anthropic").textContent).not.toContain("Configured");
  });

  it("does not call the backend with an empty field", async () => {
    const backend = makeBackend([{ provider: "anthropic", configured: false }]);
    const dialog = new SecretsDialog(document.body, backend);
    await dialog.open();

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
});

function row(provider: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-provider="${provider}"]`);
  if (!el) throw new Error(`no row for ${provider}`);
  return el;
}

function input(provider: string): HTMLInputElement {
  const el = row(provider).querySelector<HTMLInputElement>("input");
  if (!el) throw new Error(`no input for ${provider}`);
  return el;
}

function button(provider: string, action: string): HTMLButtonElement {
  const el = row(provider).querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (!el) throw new Error(`no ${action} button for ${provider}`);
  return el;
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test secrets`
Expected: FAIL — cannot resolve `../src/ui/secrets`.

- [ ] **Step 4: Implement the dialog**

`src/ui/secrets.ts`:

```typescript
// API key entry (CLAUDE.md §5, ROADMAP Movement IV).
//
// This module can display *whether* a key is stored, never the key: the backend
// exposes no command that returns one. The input is write-only — filled by the
// user, sent to Rust, then blanked. Nothing here caches a key.
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

/** The backend surface the dialog needs — injected so tests run without Tauri. */
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
    this.close();

    const root = document.createElement("div");
    root.className = "secrets-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "API keys");

    const heading = document.createElement("h2");
    heading.textContent = "API keys";
    root.append(heading);

    const blurb = document.createElement("p");
    blurb.className = "secrets-blurb";
    blurb.textContent =
      "Keys are stored in your operating system's keychain, not in your notes. " +
      "Toril cannot show a key back to you once it is saved.";
    root.append(blurb);

    this.root = root;
    this.host.append(root);

    const statuses = await this.backend.listApiKeys();
    for (const status of statuses) {
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
    label.textContent = PROVIDER_LABELS[status.provider] ?? status.provider;
    row.append(label);

    const input = document.createElement("input");
    // Masked: the field is write-only, and a shoulder-surfer should not read it.
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Paste a key to replace the stored one";
    label.append(input);

    const state = document.createElement("span");
    state.className = "secrets-state";
    row.append(state);

    const save = document.createElement("button");
    save.dataset.action = "save";
    save.textContent = "Save";
    row.append(save);

    const clear = document.createElement("button");
    clear.dataset.action = "clear";
    clear.textContent = "Clear";
    row.append(clear);

    const render = (configured: boolean) => {
      state.textContent = configured ? "Configured" : "Not set";
    };
    render(status.configured);

    save.addEventListener("click", () => {
      const key = input.value.trim();
      // An empty field is a no-op, not an error — the user may have opened the
      // dialog to check state rather than to change anything.
      if (key === "") return;
      void this.backend
        .setApiKey(status.provider, key)
        .then(() => {
          input.value = "";
          render(true);
        })
        .catch((err: unknown) => {
          state.textContent = err instanceof Error ? err.message : String(err);
        });
    });

    clear.addEventListener("click", () => {
      void this.backend
        .clearApiKey(status.provider)
        .then(() => {
          input.value = "";
          render(false);
        })
        .catch((err: unknown) => {
          state.textContent = err instanceof Error ? err.message : String(err);
        });
    });

    return row;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test secrets && pnpm typecheck`
Expected: PASS, 8 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ui/secrets.ts tests/secrets.test.ts
git commit -m "feat(ui): add the API keys dialog"
```

---

### Task 7: Wire the menu, style the dialog, and update the gates

**Files:**
- Modify: `src-tauri/src/menu.rs`
- Modify: `src/main.ts`
- Modify: `src/styles.css`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`, `CLAUDE.md` (§4, §5, §8)

**Interfaces:**
- Consumes: `SecretsDialog` from Task 6.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the menu item**

In `src-tauri/src/menu.rs`, in the `file` submenu, after the export items and before `.separator().quit()`:

```rust
        .separator()
        .text("menu_api_keys", "API Keys…")
```

- [ ] **Step 2: Handle the menu action in `main.ts`**

Import the dialog and add a case to the existing `menu` action handler, matching how sibling `menu_*` ids are dispatched:

```typescript
import { SecretsDialog } from "./ui/secrets";

const secretsDialog = new SecretsDialog(document.body);
```

and in the menu-action switch:

```typescript
    case "menu_api_keys":
      void secretsDialog.open();
      break;
```

- [ ] **Step 3: Style the dialog**

Append to `src/styles.css`, using the existing theme variables rather than literal colors:

```css
/* API keys dialog (ROADMAP Movement IV). Centered overlay panel; colors come
   from the theme variables so it follows System/Light/Dark like everything else. */
.secrets-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 40;
  min-width: 26rem;
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated, var(--bg));
  color: var(--fg);
  box-shadow: 0 10px 30px rgb(0 0 0 / 35%);
}

.secrets-dialog h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}

.secrets-blurb {
  margin: 0 0 1rem;
  font-size: 0.8125rem;
  opacity: 0.75;
}

.secrets-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: end;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.secrets-row label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
}

.secrets-row input {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
}

.secrets-state {
  grid-column: 1 / -1;
  font-size: 0.75rem;
  opacity: 0.75;
}

.secrets-close {
  margin-top: 0.5rem;
}
```

- [ ] **Step 4: Add `keystore` to the CI matrix**

In `.github/workflows/ci.yml`, add `-p keystore` to the `Test logic crates` step and change the comment "These eight are split out" to "These nine are split out".

- [ ] **Step 5: Update the docs**

- `README.md`: add `-p keystore` to the "Backend logic tests" command.
- `CLAUDE.md` §4: add `crates/keystore/` and `commands/secrets.rs` and `src/ui/secrets.ts` to the tree.
- `CLAUDE.md` §5: add the four commands to the table, with a note that no getter exists.
- `CLAUDE.md` §8: add the keystore gate and record that `OsKeychain` is on-device-only.

- [ ] **Step 6: Run the full gate set**

Run:
```bash
pnpm typecheck && pnpm test
cd src-tauri && cargo fmt --all --check && cargo test -p fsatomic -p vaultscan -p mdhtml -p mdrtf -p imgasset -p trashbin -p snapshots -p mergemd -p keystore && cargo clippy
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(secrets): wire the API keys menu item, styles, CI gate, and docs"
```

---

## Self-Review

**Spec coverage.** §3.1–3.3 → Tasks 1–2. §4.2 → Tasks 3–4. §4.3 → Task 5. §4.4 → Task 6. §5 (data safety) → enforced by the no-getter shape in Task 5 and the `error_messages_never_contain_the_secret` test in Task 3. §6 (gates) → Tasks 3 and 6, wired into CI in Task 7. §7 (branch split) → the Part A / Part B headings. §8 (on-device verification) → recorded in the design doc; no task can automate it.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code.

**Type consistency.** `Provider::as_str()` returns the same ids (`"anthropic"`, `"openai"`) that `ProviderId` declares in TypeScript and that `ProviderStatus.provider` carries over the wire. `ProviderStatus` is `{ provider, configured }` in both Rust (camelCase-serialized) and TS. `SecretsDialog.open()`/`close()` match between Task 6's implementation and Task 7's call site. `PROVIDER_LABELS` is exported in Task 6 and imported by its own test.
