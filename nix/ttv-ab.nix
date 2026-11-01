# Purpose: Unpacked TTV AB Chromium extension from the upstream release zip, for --load-extension
{ fetchzip }:
let
  version = "26.0.1";
in
fetchzip {
  pname = "ttv-ab";
  inherit version;
  url = "https://github.com/GosuDRM/TTV-AB/releases/download/v${version}/ttv-ab-${version}-chrome.zip";
  hash = "sha256-99IL25YSn3LnbOMmvxGQmRQ/vxTeBKm2g+AG2hlJyEE=";
  stripRoot = false;
  meta = {
    description = "Twitch ad blocker for Chromium browsers";
    homepage = "https://github.com/GosuDRM/TTV-AB";
    license = {
      fullName = "MIT-Based License with Repository Attribution";
      url = "https://github.com/GosuDRM/TTV-AB/blob/v${version}/LICENSE";
      free = true;
      redistributable = true;
    };
  };
}
