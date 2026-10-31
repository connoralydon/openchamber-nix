# NixOS configuration

Import this flake's `nixosModules.default` and enable `services.openchamber`.
Use `services.openchamber.settings` for non-secret settings. The module applies
those fields through OpenChamber's settings API and preserves other fields.
Never put credentials in `settings`, because Nix writes these values to the store.

This fork keeps its existing `openchamber-web` and `default` packages and its
NixOS module options. `flake.nix` uses `nix/packages/openchamber-web.nix` and
`nix/modules/openchamber.nix`. Upstream's separate Nix package and module files
are not used by this fork's flake.

## Per-client preferences

Use `services.openchamber.settingsBySurface` to manage preferences separately for
`web`, `desktop`, `vscode`, and `mobile`. The phone app and hosted mobile website
use the same `mobile` profile. Common values in `settings` do not replace saved
per-client choices, so configure each client profile that Nix must manage.

Only preferences marked `perSurface` in OpenChamber's settings registry are valid
in `settingsBySurface`. Put shared preferences, such as
`openTrackerLinksOnBoard`, in `settings`. The module rejects a shared setting in a
client profile because an API write there would change its common value.

The module applies and verifies configured fields through the settings API at
startup and at the reconciliation interval. It preserves unlisted fields and
profiles. Removing a field from Nix stops management but leaves its saved value
in place. These values are not locked: UI changes last until the next run.
No settings reset or data migration is needed. Keep credentials out of both
settings options because their values enter the Nix store.

## Application shortcuts

Define custom bindings in the consuming configuration through
`services.openchamber.settings.shortcutOverrides`. The module applies that map
without selecting a shortcut layout. Browsers and editors can reserve keys;
choose another binding when the client cannot receive it. Inspect the active
bindings in Settings or the help dialog.

Nix manages the complete `shortcutOverrides` map. Include existing custom bindings
before enabling management. The module applies the map at startup and at the
configured reconciliation interval. Removing the map from Nix stops management
but leaves saved bindings in place until they are reset in Settings.

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

## Upgrade compatibility

Upstream 2.4 supports `stickyUserHeader` again after its removal in 2.3.
A stored `chatRenderMode` value of `sorted` now uses live
message order with collapsed activity. It does not retain the old Sorted layout.

Settings reconciliation fails when the server rejects or changes a managed
value. Test the consuming configuration with the new input before updating its
lock file. A Nix rollback restores package and module code, but leaves stored
settings and voice keys unchanged. Test those files with the previous package
before deployment.

## Checks

Run `nix flake check` to validate module wiring and reconciliation behavior.
For the focused reconciliation tests, run:

```sh
node --test nix/modules/openchamber-settings-reconcile.test.mjs
```
