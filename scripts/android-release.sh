#!/usr/bin/env bash
# Builds the signed release APK for mobile (arm64): release/TGPhotos-release-arm64.apk
#
# Signs with the release key if assinar-android.sh already configured it
# (keystore.local.env); otherwise with the debug one. It can also be set by hand:
#   KEYSTORE=~/keys/tgphotos.jks KEY_ALIAS=tgphotos KS_PASS=... KEY_PASS=... npm run android:release
set -euo pipefail

cd "$(dirname "$0")/.."

# Each app in its own target: the Tauri build script generates the Kotlin with the
# app package (com.tgcloud.<app>) and does not run again when only the package
# changes, so a target shared between apps mixes the packages.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(cd .. && pwd)/target/android-$(basename "$PWD")}"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
# NDK and build-tools: uses the newest installed versions, unless already set.
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
BT="${BUILD_TOOLS:-$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)}"

# Release key configured by assinar-android.sh (at the tgcloud root);
# without it, signs with the debug one (good enough for testing).
if [ -f keystore.local.env ]; then
  # shellcheck disable=SC1091
  . ./keystore.local.env
fi

KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
KEY_ALIAS="${KEY_ALIAS:-androiddebugkey}"
KS_PASS="${KS_PASS:-android}"
KEY_PASS="${KEY_PASS:-$KS_PASS}"

UNSIGNED=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
OUT=release/TGPhotos-release-arm64.apk

echo "› NDK: $NDK_HOME"
echo "› build-tools: $BT"
echo "› chave: $KEYSTORE ($KEY_ALIAS)"

# Version from the last tag (as in CI): the APK installs over the released one
# without "downgrade". Without a tag, the package.json one.
TAG="$( (git ls-remote --tags origin 2>/dev/null | awk -F/ '{print $3}'; git tag) | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -uV | tail -1)"
if [ -n "$TAG" ]; then
  echo "versão ${TAG#v} (última tag)"
  npm run tauri android build -- --target aarch64 --apk --config "{\"version\":\"${TAG#v}\"}"
else
  npm run tauri android build -- --target aarch64 --apk
fi

mkdir -p release
"$BT/zipalign" -f -p 4 "$UNSIGNED" release/aligned.apk
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" \
  --out "$OUT" release/aligned.apk
rm -f release/aligned.apk "$OUT.idsig"
"$BT/apksigner" verify "$OUT"

echo "✓ $OUT ($(du -h "$OUT" | cut -f1))"
