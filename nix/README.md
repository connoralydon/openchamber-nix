# NixOS configuration

Import this flake's `nixosModules.default` and enable `services.openchamber`.
Use `services.openchamber.settings` for non-secret settings. The module applies
those fields through OpenChamber's settings API and preserves other fields.
Never put credentials in `settings`, because Nix writes these values to the store.

## OpenCode shortcuts

Set `services.openchamber.keybindPreset = "opencode"` to match shared OpenCode
actions. The preset uses Command+X as the leader on macOS and Control+X on
other platforms. The command palette keeps the platform's primary modifier
with P. Model cycling and OpenChamber-only shortcuts stay unchanged.

Override individual bindings through `services.openchamber.settings.shortcutOverrides`.
Explicit entries take precedence over the preset. Browsers and editors can reserve
keys such as Control+T; choose another binding when the client cannot receive it.
Inspect the active bindings in Settings or the help dialog.

Nix manages the complete `shortcutOverrides` map. Declare existing custom
bindings there before enabling the preset. The module applies the map at startup
and at the configured reconciliation interval. Removing the preset stops
management but leaves saved bindings in place until they are reset in Settings.

## Preset the transcription key

Set `services.openchamber.sttApiKeyFile` to the path of a one-line runtime key file.
For example, use the path of a SOPS or agenix secret. Keep its contents outside
the Nix store. Configure the transcription provider, URL and model in `settings`.

The settings reconciliation service reads the key through systemd credentials.
After it verifies the settings, it sends only the transcription key to
`/api/voice/keys`. OpenChamber saves it in `voice-keys.json` with mode `0600`.
Other voice keys stay unchanged. The key does not enter the OpenChamber or
OpenCode service environment. API responses and reconciliation logs contain no
key values.

The module applies the key at startup. Set `settingsReconciliation.interval`
for later runs. Each run writes the configured key again, so a rotated runtime
file replaces the saved key. When rotating a secret, have the secret manager
restart `openchamber-settings-reconcile.service` after the new file is ready.
Removing `sttApiKeyFile` stops management but leaves the saved key in place.
Clear it in Voice settings if it must be removed.

This presets the key; it does not lock Voice settings. Signed-in users can change
the key or URL between runs and can send the saved key to another destination.
Allow only trusted users. Use a dedicated key with restricted permissions and
spending limits. Enterprise mode still restricts speech to servers on the same
machine.

Retain the configured state directory across reboot. It contains OpenChamber's
settings and saved voice keys. Protect backups of that directory as credentials.

## Checks

Run `nix flake check` to validate module wiring and reconciliation behavior.
For the focused reconciliation tests, run:

```sh
node --test nix/modules/openchamber-settings-reconcile.test.mjs
```
