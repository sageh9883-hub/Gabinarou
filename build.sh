#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================================
# GABINAROU ANDROID WEBVIEW APK BUILDER
# ==========================================================

TEMPLATE="/builder/template"

# Le serveur fournit BUILD_WORK_DIR pour chaque job.
# Si le script est lancé manuellement, on utilise /builder/output.
WORK_DIR="${BUILD_WORK_DIR:-/builder/output}"
OUTPUT="${WORK_DIR}/output"

# Paramètres
APP_URL="${TARGET_URL:-${APP_URL:-https://example.com/}}"
APP_PACKAGE="${APP_PACKAGE:-com.example.generatedapp}"
APP_NAME="${APP_NAME:-Generated App}"
APP_ICON_URL="${APP_ICON_URL:-}"

START_TIME=$(date +%s)

log() {
    echo "[Gabinarou] $*" >&1
}

section() {
    echo "" >&1
    echo "==================================================" >&1
    echo "[Gabinarou] $*" >&1
    echo "==================================================" >&1
}

# ==========================================================
# START
# ==========================================================

section "DÉMARRAGE DU BUILD"

log "Job ID   : ${JOB_ID:-manuel}"
log "URL      : ${APP_URL}"
log "PACKAGE  : ${APP_PACKAGE}"
log "NOM      : ${APP_NAME}"
log "ICÔNE    : ${APP_ICON_URL:-aucune}"

log "Template : ${TEMPLATE}"
log "Work dir : ${WORK_DIR}"
log "Output   : ${OUTPUT}"

# ==========================================================
# VÉRIFICATION TEMPLATE
# ==========================================================

if [ ! -d "$TEMPLATE" ]; then
    log "ERREUR: template introuvable : $TEMPLATE"
    exit 1
fi

cd "$TEMPLATE"

# ==========================================================
# CONFIGURATION
# ==========================================================

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
    log "gradlew trouvé"
else
    log "ERREUR: gradlew introuvable"
    exit 1
fi

# ==========================================================
# ENVIRONNEMENT
# ==========================================================

section "VÉRIFICATION ENVIRONNEMENT"

log "Java :"
java -version 2>&1

log "JAVA_HOME : ${JAVA_HOME:-non défini}"
log "ANDROID_HOME : ${ANDROID_HOME:-non défini}"
log "ANDROID_SDK_ROOT : ${ANDROID_SDK_ROOT:-non défini}"

log "Gradle wrapper :"
./gradlew --version

# ==========================================================
# NETTOYAGE
# ==========================================================

section "NETTOYAGE BUILD PRÉCÉDENT"

rm -rf app/build
rm -rf "$OUTPUT"

mkdir -p "$OUTPUT"

log "Ancien résultat supprimé"
log "Dossier de sortie créé"

# ==========================================================
# COMPILATION
# ==========================================================

section "COMPILATION ANDROID"

log "Lancement de Gradle..."
log "Sortie Gradle en temps réel :"
echo ""

set +e

./gradlew assembleDebug \
    --no-daemon \
    --console=plain \
    --stacktrace \
    --warning-mode=all

GRADLE_EXIT=$?

set -e

echo ""

# ==========================================================
# ÉCHEC
# ==========================================================

if [ "$GRADLE_EXIT" -ne 0 ]; then

    section "ÉCHEC DU BUILD"

    log "Gradle a retourné le code : ${GRADLE_EXIT}"

    log "Contenu du dossier app/build :"

    find app/build -type f 2>/dev/null | sort || true

    exit "$GRADLE_EXIT"
fi

# ==========================================================
# GRADLE TERMINÉ
# ==========================================================

section "GRADLE TERMINÉ"

APK="app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$APK" ]; then

    log "ERREUR: APK introuvable"
    log "Fichiers générés :"

    find app/build -type f 2>/dev/null | sort || true

    exit 1
fi

APK_SIZE=$(du -h "$APK" | cut -f1)

log "APK trouvé : $APK"
log "Taille APK : $APK_SIZE"

# ==========================================================
# COPIE APK
# ==========================================================

section "COPIE DE L'APK"

cp "$APK" "$OUTPUT/app-debug.apk"

if [ ! -f "$OUTPUT/app-debug.apk" ]; then
    log "ERREUR: copie APK impossible"
    exit 1
fi

log "APK copié vers : $OUTPUT/app-debug.apk"

# ==========================================================
# FIN
# ==========================================================

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

section "BUILD TERMINÉ"

log "APK      : $OUTPUT/app-debug.apk"
log "Taille   : $APK_SIZE"
log "Durée    : ${DURATION}s"
log "BUILD SUCCESSFUL"

echo ""
echo "=================================================="
echo " GABINAROU BUILD SUCCESSFUL"
echo " APK READY"
echo "=================================================="
