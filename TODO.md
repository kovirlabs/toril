# TODO

The forward plan now lives in **[ROADMAP.md](./ROADMAP.md)** — branch-by-branch,
with publicity guidance at each stage.

The long-standing **Windows code-signing** task (Azure Trusted Signing) has moved
there too: see *Movement I → `feat/release-readiness`*. The specifics still hold —
set up an Azure Trusted Signing account + certificate profile (identity validation;
individual vs. org path), add `bundle.windows.signCommand` → `trusted-signing-cli`
in `tauri.conf.json`, add `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID`
as GitHub Actions secrets and sign in the Windows `release.yml` job, then soften the
SmartScreen note in `README.md` and `docs/index.html`. (Trusted Signing is OV-class:
it builds SmartScreen reputation over downloads/time, it doesn't bypass the warning
instantly like an EV cert.)

Full reference — current signing state, the Windows installer quirks that *were*
solved (NSIS-vs-MSI, per-user install, WebView2 bootstrapper), and the
implementation checklist — lives in **[WINDOWS-SIGNING.md](./WINDOWS-SIGNING.md)**.
