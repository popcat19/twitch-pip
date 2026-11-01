# twitch-pip

A Home Manager module that toggles a pinned, floating Twitch player (and optionally its chat) in an isolated [Helium](https://github.com/imputnet/helium) profile with [TTV AB](https://github.com/GosuDRM/TTV-AB) loaded. While the window is open, the player and chat switch in place to the first live channel in a priority list, or show a fallback channel when none are live.

## Usage

```nix
# flake.nix inputs
twitch-pip = {
  url = "git+https://dawn.wine/popcat19/twitch-pip.git?ref=main";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

```nix
# home-manager
imports = [ inputs.twitch-pip.homeModules.default ];

programs.twitch-pip = {
  enable = true;
  channels = [ "caseoh_" "jinxi" "xqc" ];
  fallback = "caseoh247";
  hyprland.binds = {
    toggle = "SUPER, Y";
    chat = "SUPER SHIFT, Y";
  };
};
```

## Commands

| Command | Effect |
| --- | --- |
| `twitch-pip toggle` | Open or close the player |
| `twitch-pip chat` | Open or close popout chat for the current channel |
| `twitch-pip login` | Open twitch.tv/login in a normal window of the same profile |
| `twitch-pip status` | List open player and chat pages |
| `twitch-pip quit` | Close the browser |

Log in once with `twitch-pip login`. The session lives in `profileDir`, so captchas and chat work as on twitch.tv.

## Behaviour

- Live checks use `decapi.me/twitch/uptime/<login>` every `pollSeconds` (default 60). An unknown or failed result on a higher-priority channel keeps the current stream instead of falling through.
- One `serve` process owns the browser over `--remote-debugging-pipe`. No TCP debug port is opened. Hotkeys talk to it through `$XDG_RUNTIME_DIR/twitch-pip.sock`.
- Closing the last window quits the browser and `serve`.
- F5 reloads the page as in any browser window.
- Hyprland rules float, pin and place the player in the bottom-right corner with chat above it, and keep both from taking focus when they open. Pinned floats stay visible over fullscreen windows.
- Helium is built against the consumer's `pkgs`. Using a different nixpkgs than the system can break GPU acceleration through a glibc mismatch with `/run/opengl-driver`.
