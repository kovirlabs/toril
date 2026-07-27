//! OS-keychain-backed API key storage (CLAUDE.md §3, ROADMAP Movement IV).
//!
//! The security property here comes from the **API shape**, not the backend.
//! `get` exists so Rust-side provider calls can use a key; it is deliberately
//! never exposed as a Tauri command, so a secret cannot cross into the webview
//! — which §3.3 already treats as untrusted. See `commands/secrets.rs`.
//!
//! Split out as a workspace crate so the contract is unit-testable without a
//! desktop session: every test here runs against `MemoryStore`. `OsKeychain`
//! itself is verified on-device only, because CI's Linux runners have no Secret
//! Service.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Mutex;

use zeroize::Zeroizing;

/// Providers that require an API key. A closed enum rather than a free-text id,
/// so a typo cannot silently create an orphaned keychain entry.
///
/// Ollama is absent on purpose: it is local and unauthenticated, and needs a
/// host URL rather than a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Anthropic,
    OpenAi,
}

impl Provider {
    /// Every provider, for `list_api_keys`.
    pub const ALL: [Provider; 2] = [Provider::Anthropic, Provider::OpenAi];

    /// Stable wire id — also the keychain *account* name. Renaming a variant
    /// must not change this without a migration, or stored keys are orphaned.
    pub const fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
        }
    }
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

/// Failure modes, mapped to stable user-facing strings.
///
/// No variant carries the secret value: `Backend` holds only the platform's own
/// message. `error_messages_never_contain_the_secret` pins that, because these
/// strings reach the UI and could otherwise leak a key into a screenshot.
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
            KeystoreError::Backend(msg) => {
                write!(f, "the system keychain refused the request: {msg}")
            }
        }
    }
}

impl std::error::Error for KeystoreError {}

/// Lower bound catches a truncated paste; upper bound catches pasting a whole
/// file into the field. Deliberately loose and provider-agnostic — a hard-coded
/// `sk-ant-` prefix check would age badly as key formats change.
const MIN_SECRET_LEN: usize = 8;
const MAX_SECRET_LEN: usize = 1024;

/// Reject a secret that cannot be stored, or that could not later be sent as an
/// HTTP header.
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
/// `get` returns `Zeroizing<String>` so our copy is overwritten on drop rather
/// than left behind in freed heap.
pub trait SecretStore {
    fn set(&self, provider: Provider, secret: &str) -> Result<(), KeystoreError>;
    fn get(&self, provider: Provider) -> Result<Option<Zeroizing<String>>, KeystoreError>;
    fn clear(&self, provider: Provider) -> Result<(), KeystoreError>;
    fn contains(&self, provider: Provider) -> Result<bool, KeystoreError>;
}

/// In-memory double. Exists so the `SecretStore` contract has a gate that runs
/// on any machine; the app itself never uses it.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_round_trip() {
        for p in Provider::ALL {
            assert_eq!(p.as_str().parse::<Provider>().unwrap(), p);
        }
    }

    #[test]
    fn unknown_provider_id_is_rejected() {
        assert!("pineapple".parse::<Provider>().is_err());
    }

    #[test]
    fn rejects_empty_and_whitespace_only_secrets() {
        assert!(matches!(
            validate_secret(""),
            Err(KeystoreError::EmptySecret)
        ));
        assert!(matches!(
            validate_secret("      \t  "),
            Err(KeystoreError::EmptySecret)
        ));
    }

    #[test]
    fn rejects_control_characters() {
        // A newline here would corrupt an HTTP header once Movement IV sends it,
        // so entry is the honest place to reject it.
        assert!(matches!(
            validate_secret("sk-ant-abcdef\nghij"),
            Err(KeystoreError::InvalidCharacter)
        ));
        assert!(matches!(
            validate_secret("sk-ant-abcdef\rghij"),
            Err(KeystoreError::InvalidCharacter)
        ));
        assert!(matches!(
            validate_secret("sk-ant-ab\u{0}cdefgh"),
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
            store
                .get(Provider::Anthropic)
                .unwrap()
                .as_deref()
                .map(String::as_str),
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
        store
            .set(Provider::Anthropic, "sk-ant-secondvalue")
            .unwrap();

        assert_eq!(
            store
                .get(Provider::Anthropic)
                .unwrap()
                .as_deref()
                .map(String::as_str),
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
        assert!(store.set(Provider::Anthropic, "bad\nkeyvalue").is_err());
        assert!(!store.contains(Provider::Anthropic).unwrap());
    }
}
