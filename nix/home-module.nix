# Purpose: Home Manager module that installs twitch-pip, writes its config, and adds Hyprland window rules and binds
{ helium, src }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.twitch-pip;
  login = lib.types.strMatching "[a-z0-9_]{1,25}";
  size = lib.types.submodule {
    options = {
      height = lib.mkOption { type = lib.types.ints.positive; };
      width = lib.mkOption { type = lib.types.ints.positive; };
    };
  };
  exe = lib.getExe cfg.package;
  bindOption =
    action: example:
    lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      inherit example;
      description = "Hyprland bind (mods, key) that runs `twitch-pip ${action}`. Null adds no bind.";
    };
  m = cfg.hyprland.margin;
  # window_w/window_h resolve to the client's requested size, not the size rule, so offsets
  # come from the configured sizes.
  fromRight = w: "(monitor_w-${toString (w + m)})";
  fromBottom = h: "(monitor_h-${toString (h + m)})";
  p = cfg.playerSize;
  c = cfg.chatSize;
  # Chromium derives the Wayland app_id from the --app URL and ignores --class.
  playerClass = "^chrome-player\\.twitch\\.tv__-.+$";
  chatClass = "^chrome-www\\.twitch\\.tv__popout_[a-z0-9_]+_chat-.+$";
  pinned = class: w: h: x: y: [
    "float on, match:class ${class}"
    "pin on, match:class ${class}"
    "size ${toString w} ${toString h}, match:class ${class}"
    "move ${x} ${y}, match:class ${class}"
    "no_initial_focus on, match:class ${class}"
    # Blur would smear what shows through a translucent popup.
    "no_blur on, match:class ${class}"
    "opacity ${toString cfg.hyprland.opacity} ${toString cfg.hyprland.opacity}, match:class ${class}"
  ];
in
{
  options.programs.twitch-pip = {
    enable = lib.mkEnableOption "pinned Twitch player in an isolated Helium profile";

    authTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/agenix/twitch-auth-token";
      description = ''
        Runtime path to a file holding the twitch.tv `auth-token` cookie value, for example an
        agenix secret. It is injected into the profile on every start and overrides a manual login.
        Must be a string path so the token never enters the Nix store.
      '';
    };

    browser = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage "${helium}/helium.nix" { };
      defaultText = lib.literalExpression "helium built against the consumer's pkgs";
      description = "Chromium-based browser package. Built from the consumer's nixpkgs so its glibc matches the system Mesa driver.";
    };

    channels = lib.mkOption {
      type = lib.types.listOf login;
      example = [
        "caseoh_"
        "xqc"
      ];
      description = "Twitch logins in priority order. The first live one plays.";
    };

    chatSize = lib.mkOption {
      type = size;
      default = {
        height = 600;
        width = 340;
      };
      description = "Floating chat window size in logical pixels.";
    };

    extensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ (pkgs.callPackage "${src}/nix/ttv-ab.nix" { }) ];
      defaultText = lib.literalExpression "[ ttv-ab ]";
      description = "Unpacked extension directories passed to --load-extension.";
    };

    extraFlags = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra browser command-line flags.";
    };

    fallback = lib.mkOption {
      type = login;
      description = "Channel shown when every entry in `channels` is offline.";
    };

    hyprland = {
      binds = {
        chat = bindOption "chat" "SUPER SHIFT, Y";
        quit = bindOption "quit" "SUPER CTRL, Y";
        reset = bindOption "reset" "SUPER ALT, Y";
        toggle = bindOption "toggle" "SUPER, Y";
      };
      enable =
        lib.mkEnableOption "Hyprland window rules that float, pin and place the player and chat"
        // {
          default = true;
        };
      margin = lib.mkOption {
        type = lib.types.ints.unsigned;
        default = 24;
        description = "Gap from the bottom-right monitor corner in logical pixels.";
      };
      opacity = lib.mkOption {
        type = lib.types.numbers.between 0.1 1.0;
        default = 1.0;
        example = 0.8;
        description = "Window opacity for the player and chat, focused or not.";
      };
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage "${src}/nix/twitch-pip.nix" { inherit src; };
      defaultText = lib.literalExpression "twitch-pip";
      description = "twitch-pip controller package.";
    };

    playerSize = lib.mkOption {
      type = size;
      default = {
        height = 324;
        width = 576;
      };
      description = "Floating player window size in logical pixels.";
    };

    pollSeconds = lib.mkOption {
      type = lib.types.ints.between 15 3600;
      default = 60;
      description = "Seconds between live checks while the browser is open.";
    };

    profileDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.dataHome}/twitch-pip/profile";
      defaultText = lib.literalExpression ''"''${config.xdg.dataHome}/twitch-pip/profile"'';
      description = "Isolated browser profile directory. Holds the Twitch login.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        home.packages = [ cfg.package ];
        xdg.configFile."twitch-pip/config.json".text = builtins.toJSON {
          inherit (cfg)
            authTokenFile
            channels
            extraFlags
            fallback
            pollSeconds
            profileDir
            ;
          browser = lib.getExe cfg.browser;
          extensions = map toString cfg.extensions;
          # Lets the script hide, show and reset the windows the rules below match.
          hyprland =
            if cfg.hyprland.enable then
              {
                inherit (cfg.hyprland) margin;
                classes = {
                  chat = chatClass;
                  player = playerClass;
                };
                sizes = {
                  chat = cfg.chatSize;
                  player = cfg.playerSize;
                };
              }
            else
              null;
        };
      }
      (lib.mkIf cfg.hyprland.enable {
        wayland.windowManager.hyprland.settings = {
          bind = lib.mapAttrsToList (action: key: "${key}, exec, ${exe} ${action}") (
            lib.filterAttrs (_: key: key != null) cfg.hyprland.binds
          );
          windowrule =
            pinned playerClass p.width p.height (fromRight p.width) (fromBottom p.height)
            ++ pinned chatClass c.width c.height (fromRight c.width) (fromBottom (c.height + p.height + m));
        };
      })
    ]
  );
}
