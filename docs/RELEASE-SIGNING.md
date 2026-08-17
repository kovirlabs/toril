# Release Signing & Self-Update

Two different signatures, for two different problems. They are easy to confuse
because both are called "signing", so this file keeps them apart.

| | **Update signing** (minisign) | **Code signing** (Authenticode) |
|---|---|---|
| Answers | "Did this update really come from Toril?" | "Is this installer from a known publisher?" |
| Needed for | The in-app updater to install anything | Windows SmartScreen to stop warning |
| Costs | Nothing | An Azure subscription (monthly) + identity validation |
| Blocks a release? | **Yes** — `release.yml` fails fast without it | No — builds unsigned, as today |

---

## 1. Update signing — required

`bundle.createUpdaterArtifacts` is on, so every release build produces signed
update artifacts plus a `latest.json` manifest. The bundler refuses to emit an
*unsigned* update, which is why the release workflow checks for the key up front
and stops with an explanation rather than failing deep in a Rust build.

**One-time setup:**

```bash
pnpm tauri signer generate -w ~/.tauri/toril-updater.key
```

It prints a public key and writes the private key to that path. Then:

1. Paste the **public** key into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`. It ships inside the app and is what an installed
   copy uses to verify a downloaded update, so it must be committed.
2. Add the **private** key file's *contents* as the repository secret
   `TAURI_SIGNING_PRIVATE_KEY`.
3. If you set a password, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

**Keep the private key.** It is not recoverable, and it is not rotatable in the
usual sense: every copy of Toril already installed verifies against the public
key it shipped with. Lose the private key and those copies can never be updated
again — their owners would have to download a new installer by hand, which is
the exact situation this branch exists to end. Back it up somewhere you would
also keep a password manager export.

> **The private key must never be committed.** `.gitignore` covers the
> conventional `*.key` / `.tauri/` paths as a backstop, but the intended home is
> outside the repository entirely.

---

## 2. Windows code signing — optional, and needs an account first

Without it, SmartScreen warns on first run. That is expected, not a bug, and
`README.md` says so.

Turning it on is **not** a code change you can finish in one sitting — it needs
an Azure Trusted Signing account and an identity validation that takes business
days. The wiring is already in place and inert until the secrets exist:

- `src-tauri/tauri.signing.conf.json` — the `signCommand` overlay. It lives in
  its own file, applied only in CI, so a fork or a local `pnpm tauri build`
  still produces a working unsigned installer instead of failing on a missing
  tool. Nobody needs an Azure subscription to build Toril.
- `.github/workflows/release.yml` — installs `trusted-signing-cli` and applies
  the overlay **only** when `AZURE_CLIENT_ID` is present.

**To enable it:**

1. Create an Azure Trusted Signing account and a certificate profile, and
   complete identity validation.
2. Update the endpoint / account / profile names in
   `src-tauri/tauri.signing.conf.json` — the committed values are placeholders
   (`toril-signing`, `toril`) and will not match your account.
3. Add repository secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
   `AZURE_TENANT_ID` for a service principal with the *Trusted Signing Certificate
   Profile Signer* role.
4. Soften the SmartScreen wording in `README.md`, `docs/index.html`, and the
   `releaseBody` in `release.yml`. Verify on a real Windows machine before you
   do — B9 in `docs/ON-DEVICE-VERIFICATION.md`.

---

## 3. What the app does with an update

Policy lives in `src/update.ts` and is gated by `tests/update.test.ts`.

- Checks at most once a day at launch, and whenever you ask via
  **Help → Check for Updates…**.
- The check is a plain GET for a static manifest. No telemetry: nothing about
  the user, the vault, or the session goes with it.
- **Toril never installs on its own.** It offers; you choose. A restart is
  refused while any tab is unsaved — the install is already on disk and applies
  next launch, so waiting costs nothing (§3).
- Automatic checks can be turned off in **View → Check for Updates on Launch**.
