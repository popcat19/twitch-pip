{
  description = "Pinned Twitch player in an isolated Helium profile with TTV AB and runtime live-channel switching";

  inputs = {
    helium = {
      url = "github:oxcl/nix-flake-helium-browser";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      helium,
      nixpkgs,
      self,
    }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      homeModules.default = import ./nix/home-module.nix {
        inherit helium;
        src = self;
      };

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = self.packages.${system}.twitch-pip;
          helium = pkgs.callPackage "${helium}/helium.nix" { };
          ttv-ab = pkgs.callPackage ./nix/ttv-ab.nix { };
          twitch-pip = pkgs.callPackage ./nix/twitch-pip.nix { src = self; };
        }
      );
    };
}
