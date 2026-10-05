#!/usr/bin/env bash
# Gera o APK release assinado para celular (arm64): release/TGPhotos-release-arm64.apk
#
# Assina com a chave de release se o assinar-android.sh já a configurou
# (keystore.local.env); senão com a de depuração. Também dá para apontar à mão:
#   KEYSTORE=~/chaves/tgphotos.jks KEY_ALIAS=tgphotos KS_PASS=... KEY_PASS=... npm run android:release
set -euo pipefail

cd "$(dirname "$0")/.."

# Cada app num target próprio: o build script do Tauri gera o Kotlin com o
# pacote do app (com.tgcloud.<app>) e não roda de novo quando só o pacote
# muda, então um target dividido entre apps mistura os pacotes.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(cd .. && pwd)/target/android-$(basename "$PWD")}"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
# NDK e build-tools: usa as versões mais novas instaladas, salvo se já definidas.
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
BT="${BUILD_TOOLS:-$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)}"

# Chave de release configurada pelo assinar-android.sh (na raiz do tgcloud);
# sem ela, assina com a de depuração (serve para testar).
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

# Versão da última tag (como no CI): o APK instala por cima do da release
# sem "downgrade". Sem tag, a do package.json.
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
