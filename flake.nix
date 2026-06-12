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

      nixosModules.openchamber = ./nix/modules/openchamber.nix;
      nixosModules.default = self.nixosModules.openchamber;
    };
}
