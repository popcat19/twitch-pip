# twitch-pip

A Home Manager module that toggles a pinned, floating Twitch player (and optionally its chat) in an isolated [Helium](https://github.com/imputnet/helium) profile with [TTV AB](https://github.com/GosuDRM/TTV-AB) loaded. While the window is open, the player and chat switch in place to the first live channel in a priority list, or show a fallback channel when none are live.

## Usage

```nix
# flake.nix inputs
twitch-pip = {
  url = "github:popcat19/twitch-pip";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

```nix
# home-manager
imports = [ inputs.twitch-pip.homeModules.default ];

programs.twitch-pip = {
  enable = true;
  channels = [ "caseoh_" "xqc" "caseoh247" ];
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
| `twitch-pip login` | Open twitch.tv/login in a normal window of the same profile (Twitch blocks Helium password logins, see below) |
| `twitch-pip status` | List open player and chat pages |
| `twitch-pip quit` | Close the browser |

Twitch rejects password logins from Helium with "Browser not supported - integrity error" ([imputnet/helium#1756](https://github.com/imputnet/helium/issues/1756)), so `twitch-pip login` only helps on browsers Twitch accepts. Sign in from another browser and hand the session over through [Login from a secret](#login-from-a-secret). Once the cookie is in the profile, playback and chat use it as on twitch.tv.

## Login from a secret

Set `authTokenFile` to a runtime path holding the twitch.tv `auth-token` cookie. On every start, twitch-pip writes that value into the profile and reloads the open pages. Twitch's web client sends this cookie as the GQL `Authorization` header, so it is the whole login. The secret overrides any account logged in by hand.

```nix
programs.twitch-pip.authTokenFile = "/run/agenix/twitch-auth-token";
```

Use a string path. A Nix path literal would copy the token into the world-readable store.

### Extract the token

The token is a full login for the account. Do not paste it into chats, issues, or shell history.

1. In a browser Twitch accepts (Firefox, Zen, Chrome), open a **private window** and sign in to twitch.tv. A private window gives a separate session, so logging out of your daily session later does not revoke this token.
2. In that window, open DevTools with `F12` or `Ctrl+Shift+I`.
3. Open the cookie list for `https://www.twitch.tv`:
   - Firefox and Zen: **Storage → Cookies**
   - Chromium browsers: **Application → Storage → Cookies**
4. Select the `auth-token` row and copy its **Value**. It is about 30 lowercase letters and digits.
5. Close the private window without logging out. Closing it discards the cookie locally, and the token stays valid on Twitch's side.

### Encrypt it with agenix

```nix
# secrets.nix
"twitch-auth-token.age".publicKeys = [ host1 host2 ];
```

```bash
agenix -e twitch-auth-token.age
```

Paste the value as the only line, save, and quit the editor. Then expose it to your user:

```nix
age.secrets.twitch-auth-token = {
  file = ./secrets/twitch-auth-token.age;
  owner = "<user>";
  mode = "400";
};
```

### Rotate

The token stops working when the session logs out, when the password changes, or when Twitch expires it. The player then shows logged-out content. Repeat the extraction and run `agenix -e twitch-auth-token.age` again with the new value.

## Behaviour

- Live checks use `decapi.me/twitch/uptime/<login>` every `pollSeconds` (default 60). An unknown or failed result on a higher-priority channel keeps the current stream instead of falling through. 24/7 channels can sit at the end of `channels` so they are tried in order before `fallback`.
- One `serve` process owns the browser over `--remote-debugging-pipe`. No TCP debug port is opened. Hotkeys talk to it through `$XDG_RUNTIME_DIR/twitch-pip.sock`.
- Closing the last window quits the browser and `serve`.
- F5 reloads the page as in any browser window.
- Hyprland rules float, pin and place the player in the bottom-right corner with chat above it, and keep both from taking focus when they open. Pinned floats stay visible over fullscreen windows.
- Helium is built against the consumer's `pkgs`. Using a different nixpkgs than the system can break GPU acceleration through a glibc mismatch with `/run/opengl-driver`.
