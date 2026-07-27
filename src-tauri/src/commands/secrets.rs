//! API key storage (CLAUDE.md §5, ROADMAP Movement IV).
//!
//! **There is deliberately no `get_api_key` command, and there must never be
//! one.** `keystore::SecretStore::get` exists so Rust-side provider calls can
//! use a key; the webview only ever learns *whether* one is set.
//!
//! §3.3 already treats webview content as untrusted and sanitizes it. A key
//! that never crosses the IPC boundary turns a future sanitizer bypass into a
//! rendering bug rather than a stolen credential — the security property comes
//! from this API shape, not from the storage backend. A "show key" toggle is
//! not worth reversing that.

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

/// Status of every provider, so the dialog renders in one round trip.
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
