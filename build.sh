#!/usr/bin/env bash
set -euo pipefail

TEMPLATE="/builder/template"

APP_URL="${APP_URL:-https://example.com/}"
APP_PACKAGE="${APP_PACKAGE:-com.example.generatedapp}"
APP_NAME="${APP_NAME:-Generated App}"
APP_ICON_URL="${APP_ICON_URL:-}"

cd "$TEMPLATE"

cat > app.properties <<PROPERTIES
app.url=${APP_URL}
app.package=${APP_PACKAGE}
app.name=${APP_NAME}
app.icon_url=${APP_ICON_URL}
PROPERTIES

echo "======================================"
echo " Android WebView Build Worker"
echo "======================================"
echo "URL:     ${APP_URL}"
echo "Package: ${APP_PACKAGE}"
echo "Name:    ${APP_NAME}"
echo "Icon:    ${APP_ICON_URL}"
echo "======================================"

./gradlew assembleDebug --no-daemon --stacktrace

mkdir -p /builder/output

cp app/build/outputs/apk/debug/app-debug.apk \
   /builder/output/app-debug.apk

echo ""
echo "BUILD SUCCESSFUL"
echo "APK: /builder/output/app-debug.apk"
