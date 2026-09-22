#!/usr/bin/env bash

set -Eeuo pipefail

TEMPLATE="/builder/template"
OUTPUT="/builder/output"

APP_URL="${APP_URL:-https://example.com/}"
APP_PACKAGE="${APP_PACKAGE:-com.example.generatedapp}"
APP_NAME="${APP_NAME:-Generated App}"
APP_ICON_URL="${APP_ICON_URL:-}"

START_TIME=$(date +%s)

log() {
    echo "[Gabinarou] $*"
}

section() {
    echo ""
    echo "=================================================="
    echo "[Gabinarou] $*"
    echo "=================================================="
}

section "DÉMARRAGE DU BUILD"

log "URL      : ${APP_URL}"
log "PACKAGE  : ${APP_PACKAGE}"
log "NOM      : ${APP_NAME}"
log "ICÔNE    : ${APP_ICON_URL:-aucune}"

log "Template : ${TEMPLATE}"

if [ ! -d "$TEMPLATE" ]; then
    log "ERREUR: template introuvable"
    exit 1
fi

cd "$TEMPLATE"

section "CONFIGURATION"

cat > app.properties <<PROPERTIES
app.url=${APP_URL}
app.package=${APP_PACKAGE}
app.name=${APP_NAME}
app.icon_url=${APP_ICON_URL}
PROPERTIES

log "app.properties créé"

if [ -f "./gradlew" ]; then
    chmod +x ./gradlew
else
    log "ERREUR: gradlew introuvable"
    exit 1
fi

section "VÉRIFICATION ENVIRONNEMENT"

log "Java :"
java -version 2>&1

log "Gradle wrapper :"
./gradlew --version

section "NETTOYAGE BUILD PRÉCÉDENT"

rm -rf app/build
mkdir -p "$OUTPUT"

log "Ancien résultat supprimé"

section "COMPILATION ANDROID"

log "Lancement de Gradle..."
log "La sortie Gradle complète sera affichée ci-dessous."

set +e

./gradlew assembleDebug \
    --no-daemon \
    --console=plain \
    --stacktrace \
    --warning-mode=all

GRADLE_EXIT=$?

set -e

if [ "$GRADLE_EXIT" -ne 0 ]; then
    section "ÉCHEC DU BUILD"

    log "Gradle a retourné le code : ${GRADLE_EXIT}"

    log "Contenu du dossier APK :"

    find app/build -type f 2>/dev/null | sort || true

    exit "$GRADLE_EXIT"
fi

section "GRADLE TERMINÉ"

APK="app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$APK" ]; then
    log "ERREUR: APK introuvable"
    find app/build -type f 2>/dev/null | sort || true
    exit 1
fi

APK_SIZE=$(du -h "$APK" | cut -f1)

log "APK trouvé : $APK"
log "Taille APK : $APK_SIZE"

section "COPIE DE L'APK"

cp "$APK" "$OUTPUT/app-debug.apk"

if [ ! -f "$OUTPUT/app-debug.apk" ]; then
    log "ERREUR: copie APK impossible"
    exit 1
fi

section "BUILD TERMINÉ"

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

log "APK : $OUTPUT/app-debug.apk"
log "Taille : $APK_SIZE"
log "Durée : ${DURATION}s"
log "BUILD SUCCESSFUL"

echo ""
echo "=================================================="
echo " GABINAROU BUILD SUCCESSFUL"
echo " APK READY"
echo "=================================================="
