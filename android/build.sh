#!/usr/bin/env bash
# 打包安卓 APK：bash android/build.sh
# 需要：JDK 17、Android SDK（build-tools 34、platform 34）
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_SDK:-D:/AI/android-sdk}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-34/android.jar"
KEYSTORE="${MIAOBI_KEYSTORE:-$SDK/miaobi-release.keystore}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/assets/www" "$OUT/res"

# 1. 网页资源打包进 assets/www
cp ../index.html ../manifest.webmanifest ../icon.svg ../icon-512.png "$OUT/assets/www/"
cp -r ../css ../js "$OUT/assets/www/"

# 2. 编译资源 + 链接清单
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -A "$OUT/assets" "$OUT/res.zip"

# 3. 编译 Java → dex
javac -source 11 -target 11 -nowarn -encoding UTF-8 -cp "$JAR" -d "$OUT/classes" $(find src -name '*.java') 2>&1 | grep -v "bootstrap classpath" || true
"$BT/d8.bat" --release --min-api 26 --lib "$JAR" --output "$OUT" $(find "$OUT/classes" -name '*.class')

# 4. 放入 classes.dex、对齐、签名
python - "$OUT/unsigned.apk" "$OUT/classes.dex" "$OUT/merged.apk" <<'PY'
import sys, zipfile
src, dex, dst = sys.argv[1:4]
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w') as zo:
    for info in zi.infolist():
        # resources.arsc 必须不压缩（Android 11+ 要求）
        ct = zipfile.ZIP_STORED if info.filename == 'resources.arsc' or info.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED
        zo.writestr(zipfile.ZipInfo(info.filename, date_time=info.date_time), zi.read(info.filename), compress_type=ct)
    zo.write(dex, 'classes.dex', compress_type=zipfile.ZIP_DEFLATED)
PY
"$BT/zipalign" -f -p 4 "$OUT/merged.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  PASS=$(python -c "import secrets;print(secrets.token_urlsafe(18))")
  echo "$PASS" > "$KEYSTORE.pass"
  keytool -genkeypair -keystore "$KEYSTORE" -alias miaobi -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" -dname "CN=Miaobi Notes" >/dev/null 2>&1
  echo "已生成签名密钥：$KEYSTORE（请妥善保存，以后升级 App 需要同一个密钥）"
fi
PASS=$(cat "$KEYSTORE.pass")
"$BT/apksigner.bat" sign --ks "$KEYSTORE" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$OUT/miaobi-notes.apk" "$OUT/aligned.apk"
"$BT/apksigner.bat" verify -v "$OUT/miaobi-notes.apk"
ls -la "$OUT/miaobi-notes.apk"
