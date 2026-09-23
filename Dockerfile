FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# ============================================================
# ENVIRONNEMENT ANDROID
# ============================================================

ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk

ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/gradle/gradle-9.7.1/bin:$PATH

# ============================================================
# LIMITES MÉMOIRE
# ============================================================

ENV JAVA_TOOL_OPTIONS="-Xmx256m -XX:MaxMetaspaceSize=128m"
ENV GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx256m -Dorg.gradle.daemon=false"

# ============================================================
# GRADLE
# ============================================================

ENV GRADLE_VERSION=9.7.1
ENV GRADLE_HOME=/opt/gradle/gradle-9.7.1

# ============================================================
# PORT
# ============================================================

ENV NODE_ENV=production
ENV PORT=10000

# ============================================================
# INSTALLATION DES OUTILS SYSTÈME
# ============================================================

RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    wget \
    unzip \
    zip \
    git \
    curl \
    ca-certificates \
    bash \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# ANDROID COMMAND LINE TOOLS
# ============================================================

RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools

RUN wget -q \
    https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip \
    -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip \
       -d ${ANDROID_SDK_ROOT}/cmdline-tools \
    && mv \
       ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools \
       ${ANDROID_SDK_ROOT}/cmdline-tools/latest \
    && rm -f /tmp/cmdline-tools.zip

# ============================================================
# LICENCES ANDROID
# ============================================================

RUN yes | sdkmanager --licenses >/dev/null || true

# ============================================================
# INSTALLATION DU SDK ANDROID 37
# ============================================================

RUN set -eux; \
    sdkmanager --list --channel=3 > /tmp/sdk-list; \
    echo "========================================"; \
    echo "ANDROID 37 PACKAGES DISPONIBLES"; \
    echo "========================================"; \
    grep -E 'platforms;android-37|build-tools;37' /tmp/sdk-list || true; \
    echo "========================================"; \
    PLATFORM="$(grep -oE 'platforms;android-37([.]?[0-9]+)?' /tmp/sdk-list | sort -V | tail -1)"; \
    BUILD_TOOLS="$(grep -oE 'build-tools;37[.][0-9]+[.][0-9]+' /tmp/sdk-list | sort -V | tail -1)"; \
    echo "Platform sélectionnée: ${PLATFORM}"; \
    echo "Build Tools sélectionné: ${BUILD_TOOLS}"; \
    test -n "${PLATFORM}"; \
    test -n "${BUILD_TOOLS}"; \
    yes | sdkmanager --channel=3 \
        "platform-tools" \
        "${PLATFORM}" \
        "${BUILD_TOOLS}"

# ============================================================
# INSTALLATION DE GRADLE 9.7.1
# ============================================================

RUN mkdir -p /opt/gradle \
    && wget -q \
    https://services.gradle.org/distributions/gradle-9.7.1-bin.zip \
    -O /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt/gradle \
    && rm -f /tmp/gradle.zip \
    && /opt/gradle/gradle-9.7.1/bin/gradle --version

# ============================================================
# DOSSIER DU BUILDER
# ============================================================

WORKDIR /builder

# ============================================================
# CLONAGE DU TEMPLATE ANDROID
# ============================================================

RUN git clone --depth 1 \
    https://github.com/xchacha20-poly1305/webview-apk-template.git \
    /builder/template

# ============================================================
# NODE.JS
# ============================================================

COPY package.json ./

RUN npm install --omit=dev

# ============================================================
# SERVEUR
# ============================================================

COPY server.js ./

# ============================================================
# DOSSIERS DE TRAVAIL
# ============================================================

RUN mkdir -p \
    /builder/jobs \
    /builder/builds \
    /builder/workspaces \
    /builder/.gradle

# ============================================================
# GRADLE CACHE
# ============================================================

ENV GRADLE_USER_HOME=/builder/.gradle

# ============================================================
# INFORMATIONS DE BUILD
# ============================================================

RUN echo "========================================" \
    && echo "GABINAROU WEBVIEW APK BUILDER V3.3" \
    && echo "========================================" \
    && java -version \
    && gradle --version \
    && echo "Android SDK: ${ANDROID_SDK_ROOT}" \
    && echo "Gradle Home: ${GRADLE_HOME}" \
    && echo "========================================"

# ============================================================
# PORT
# ============================================================

EXPOSE 10000

# ============================================================
# START
# ============================================================

CMD ["node", "server.js"]
