# Title

Add `--os-crypt-key=<hex>` switch: caller-supplied os_crypt key for roaming profiles

# Body

## Motivation

fingerprint-chromium is commonly embedded by apps that manage multiple isolated
per-identity browser profiles, often across machines. When such a profile has to
**roam between devices** (e.g. the identity is picked up on another computer),
the copied `Cookies` / `Local Storage` files are undecryptable, because os_crypt
binds the encryption key to the local OS key store (macOS Keychain, Windows
DPAPI, Linux kwallet/gnome-libsecret). The profile directory travels, its key
does not.

An embedding app already owns a key hierarchy for the profile's data; what it
needs is a way to hand the os_crypt key to the browser at launch, exactly like
`--fingerprint-platform` etc. let the caller drive other identity aspects.

## What this adds

One new switch, `--os-crypt-key=<hex>` (see `os_crypt_switches.h`):

- **macOS / Linux** — the injected key is used directly in v11 key derivation
  (`DeriveV11Key`), bypassing the OS key store lookup. The wire format is not
  changed, so a profile written with the switch is still a standard v11
  profile; it just becomes decryptable wherever the same key is provided.
- **Windows** — `InitWithExistingKey` accepts the injected key. In addition,
  when the switch is present the roaming path writes/reads the **same v11 wire
  format as macOS/Linux** (AES-128-CBC, 16-byte key, 16-space IV), so one
  profile directory decrypts on all three platforms. The native v10
  (AES-256-GCM / DPAPI) path is untouched.

The hex value must decode to exactly the derived-key size; anything else is
ignored (falls back to the default OS path).

## Compatibility

- **Without the switch, nothing changes.** All default paths
  (Keychain / DPAPI / libsecret) behave byte-identically; no new code runs.
- Keys live in process memory only; nothing is persisted beyond the standard
  encrypted values that os_crypt already stores.
- Downside is explicit and user-controlled: a caller-supplied key is only as
  strong as the caller's key management. The switch is opt-in per launch.

## Testing

- Patch applies cleanly against the **148.0.7778.215** pristine sources
  (`git apply` round-trip verified against unpatched files).
- Built into a downstream product (Chromium 148 base + fingerprint patches) on
  all three platforms; verified that the same profile directory, carried as a
  tar+zstd snapshot between devices, restores **HttpOnly cookies and
  localStorage with full login-state retention** across macOS/Linux/Windows
  launches — asserted by an automated e2e suite, not manual inspection.
- Without the switch: existing profiles (v10 on Windows, v11 elsewhere) keep
  working; no metrics/test regressions observed in local builds.

## Notes for maintainers

Happy to rebase onto the current source branch if 150+ sources have diverged,
adjust the switch/identifier naming to house style, or add unit tests
(mock-keychain based) if you point me at the preferred test location. This is
contributed under the project's existing license.
