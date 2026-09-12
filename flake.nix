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
          reconcileService = configured.config.systemd.services.openchamber-settings-reconcile;
          reconcileTimer = configured.config.systemd.timers.openchamber-settings-reconcile;
        in
        {
          openchamber-settings-reconcile =
            assert reconcileService.serviceConfig.User == "nobody";
            assert reconcileService.serviceConfig.LoadCredential == [ "ui-password:/run/keys/openchamber" ];
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
        }
      );

      nixosModules.openchamber = ./nix/modules/openchamber.nix;
      nixosModules.default = self.nixosModules.openchamber;
    };
}
