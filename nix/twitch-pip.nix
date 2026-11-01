# Purpose: Package the twitch-pip controller script with a pinned Node runtime
{
  lib,
  nodejs,
  src,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  pname = "twitch-pip";
  version = "0.1.0";
  inherit src;
  dontBuild = true;
  installPhase = ''
    install -Dm644 src/twitch-pip.mjs $out/lib/twitch-pip/twitch-pip.mjs
    mkdir -p $out/bin
    cat > $out/bin/twitch-pip <<EOF
    #!${stdenvNoCC.shell}
    exec ${lib.getExe nodejs} $out/lib/twitch-pip/twitch-pip.mjs "\''${TWITCH_PIP_CONFIG:-\''${XDG_CONFIG_HOME:-\$HOME/.config}/twitch-pip/config.json}" "\$@"
    EOF
    chmod +x $out/bin/twitch-pip
  '';
  meta = {
    description = "Toggle a pinned Twitch player that follows the highest-priority live channel";
    mainProgram = "twitch-pip";
    platforms = lib.platforms.linux;
  };
}
