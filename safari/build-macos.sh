#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
    printf '%s\n' 'Эту сборку нужно запустить на Mac с Xcode.' >&2
    exit 1
fi

xcrun xcodebuild -version >/dev/null

args=(-project "$root/ShkolkovoSafari.xcodeproj" -scheme ShkolkovoSafari
      -configuration Release -derivedDataPath "$root/build")
if [[ -n "${SHKOLKOVO_TEAM_ID:-}" ]]; then
    args+=("DEVELOPMENT_TEAM=$SHKOLKOVO_TEAM_ID" -allowProvisioningUpdates)
else
    args+=("CODE_SIGN_IDENTITY=-")
fi

xcrun xcodebuild "${args[@]}" build

app="$root/build/Build/Products/Release/ShkolkovoSafari.app"
printf '\n%s\n' "Сборка готова. Открой приложение $app"
