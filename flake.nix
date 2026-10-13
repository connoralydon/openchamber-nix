{
  description = "Native Nix packaging and NixOS module for OpenChamber";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          openchamber-web = pkgs.callPackage ./nix/packages/openchamber-web.nix { };
          default = self.packages.${system}.openchamber-web;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          testPackage = pkgs.writeShellScriptBin "openchamber" "exit 0";
          configured = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.openchamber
              {
                system.stateVersion = "25.11";
                services.openchamber = {
                  enable = true;
                  package = testPackage;
                  createUser = false;
                  user = "nobody";
                  group = "nogroup";
                  passwordFile = "/run/keys/openchamber";
                  sttApiKeyFile = "/run/keys/openchamber-stt";
                  settings.themeVariant = "dark";
                  settingsReconciliation.interval = "2d";
                  opencode.enable = false;
                };
              }
            ];
          };
          unconfigured = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.openchamber
              {
                system.stateVersion = "25.11";
                services.openchamber = {
                  enable = true;
                  package = testPackage;
                  createUser = false;
                  opencode.enable = false;
                };
              }
            ];
          };
          keyOnly = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.openchamber
              {
                system.stateVersion = "25.11";
                services.openchamber = {
                  enable = true;
                  package = testPackage;
                  createUser = false;
                  sttApiKeyFile = "/run/keys/openchamber-stt";
                  opencode.enable = false;
                };
              }
            ];
          };
          keybindPreset = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.openchamber
              {
                system.stateVersion = "25.11";
                services.openchamber = {
                  enable = true;
                  package = testPackage;
                  createUser = false;
                  keybindPreset = "opencode";
                  opencode.enable = false;
                };
              }
            ];
          };
          keybindOverrides = keybindPreset.extendModules {
            modules = [
              {
                services.openchamber.settings = {
                  themeVariant = "dark";
                  shortcutOverrides = {
                    open_model_selector = "mod+x s";
                    focus_input = "mod+i";
                  };
                };
              }
            ];
          };
          reconcileService = configured.config.systemd.services.openchamber-settings-reconcile;
          reconcileTimer = configured.config.systemd.timers.openchamber-settings-reconcile;
        in
        {
          openchamber-keybind-preset =
            let
              shortcuts = keybindPreset.config.services.openchamber.settings.shortcutOverrides;
              overrides = keybindOverrides.config.services.openchamber.settings;
            in
            assert !(unconfigured.config.services.openchamber.settings ? shortcutOverrides);
            assert builtins.length (builtins.attrNames shortcuts) == 10;
            assert shortcuts.open_command_palette == "mod+p";
            assert shortcuts.open_model_selector == "mod+x m";
            assert shortcuts.cycle_agent == "tab";
            assert shortcuts.cycle_thinking_variant == "ctrl+t";
            assert !(shortcuts ? cycle_favorite_model_forward);
            assert keybindPreset.config.systemd.services ? openchamber-settings-reconcile;
            assert
              overrides.shortcutOverrides == shortcuts
              // {
                open_model_selector = "mod+x s";
                focus_input = "mod+i";
              };
            assert overrides.themeVariant == "dark";
            pkgs.writeText "openchamber-keybind-preset-test" (builtins.toJSON shortcuts);
          openchamber-settings-reconcile =
            assert reconcileService.serviceConfig.User == "nobody";
            assert
              reconcileService.serviceConfig.LoadCredential == [
                "ui-password:/run/keys/openchamber"
                "stt-api-key:/run/keys/openchamber-stt"
              ];
            assert reconcileService.environment.OPENCHAMBER_RECONCILE_STT_API_KEY == "true";
            assert
              configured.config.systemd.services.openchamber.serviceConfig.LoadCredential == [
                "ui-password:/run/keys/openchamber"
              ];
            assert
              keyOnly.config.systemd.services.openchamber-settings-reconcile.serviceConfig.LoadCredential == [
                "stt-api-key:/run/keys/openchamber-stt"
              ];
            assert keyOnly.config.systemd.services.openchamber.serviceConfig.LoadCredential == [ ];
            assert reconcileTimer.timerConfig.OnUnitActiveSec == "2d";
            assert configured.config.systemd.services.openchamber.serviceConfig.Restart == "always";
            assert !(unconfigured.config.systemd.services ? openchamber-settings-reconcile);
            assert unconfigured.config.systemd.services.openchamber.serviceConfig.Restart == "on-failure";
            pkgs.runCommand "openchamber-settings-reconcile-test"
              {
                nativeBuildInputs = [ pkgs.nodejs_22 ];
              }
              ''
                node --test ${./nix/modules}/openchamber-settings-reconcile.test.mjs
                touch "$out"
              '';
          openchamber-stt =
            pkgs.runCommand "openchamber-stt-test"
              {
                nativeBuildInputs = [ pkgs.nodejs_22 ];
                OPENCHAMBER_TEST_WEB_ROOT = "${
                  self.packages.${system}.openchamber-web
                }/share/openchamber/packages/web";
              }
              ''
                node --test ${./nix/modules}/openchamber-stt.integration.test.mjs
                touch "$out"
              '';
        }
      );

      nixosModules.openchamber = ./nix/modules/openchamber.nix;
      nixosModules.default = self.nixosModules.openchamber;
    };
}
