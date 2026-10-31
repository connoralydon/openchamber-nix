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
          surfaceOnly = unconfigured.extendModules {
            modules = [
              {
                services.openchamber.settingsBySurface.mobile = {
                  sidebarGrouping = "project";
                  sidebarDetailedZoneRows = true;
                };
              }
            ];
          };
          sharedInSurface = surfaceOnly.extendModules {
            modules = [
              { services.openchamber.settingsBySurface.mobile.openTrackerLinksOnBoard = false; }
            ];
          };
          reconcileService = configured.config.systemd.services.openchamber-settings-reconcile;
          reconcileTimer = configured.config.systemd.timers.openchamber-settings-reconcile;
          failedSurfaceAssertions =
            evaluated:
            nixpkgs.lib.filter (
              item:
              !item.assertion && nixpkgs.lib.hasPrefix "services.openchamber.settingsBySurface." item.message
            ) evaluated.config.assertions;
        in
        {
          openchamber-settings-reconcile =
            assert unconfigured.config.services.openchamber.settings == { };
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
            assert surfaceOnly.config.systemd.services ? openchamber-settings-reconcile;
            assert surfaceOnly.config.systemd.services.openchamber.serviceConfig.Restart == "always";
            assert failedSurfaceAssertions surfaceOnly == [ ];
            assert failedSurfaceAssertions sharedInSurface != [ ];
            pkgs.runCommand "openchamber-settings-reconcile-test"
              {
                nativeBuildInputs = [ pkgs.nodejs_22 ];
                SURFACE_SETTINGS_FILE =
                  surfaceOnly.config.systemd.services.openchamber-settings-reconcile.environment.OPENCHAMBER_RECONCILE_DESIRED_SURFACE_SETTINGS_FILE;
              }
              ''
                node --test ${./nix/modules}/openchamber-settings-reconcile.test.mjs
                node --input-type=module <<'JS'
                import assert from 'node:assert/strict';
                import { readFileSync } from 'node:fs';
                assert.deepEqual(JSON.parse(readFileSync(process.env.SURFACE_SETTINGS_FILE, 'utf8')), {
                  mobile: { sidebarGrouping: 'project', sidebarDetailedZoneRows: true },
                });
                JS
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
