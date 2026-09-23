FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk

ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH

# ============================================================
# DEPENDENCIES
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
# ANDROID LICENSES
# ============================================================

RUN yes | sdkmanager --licenses >/dev/null || true

# ============================================================
# ANDROID SDK 37
# ============================================================

RUN set -eux; \
    sdkmanager --list --channel=3 > /tmp/sdk-list; \
    echo "===== ANDROID 37 PACKAGES ====="; \
    grep -E 'platforms;android-37|build-tools;37' /tmp/sdk-list || true; \
    echo "==============================="; \
    PLATFORM="$(grep -oE 'platforms;android-37([.]?[0-9]+)?' /tmp/sdk-list | sort -V | tail -1)"; \
    BUILD_TOOLS="$(grep -oE 'build-tools;37[.][0-9]+[.][0-9]+' /tmp/sdk-list | sort -V | tail -1)"; \
    echo "Platform: ${PLATFORM}"; \
    echo "Build Tools: ${BUILD_TOOLS}"; \
    test -n "${PLATFORM}"; \
    test -n "${BUILD_TOOLS}"; \
    yes | sdkmanager --channel=3 \
        "platform-tools" \
        "${PLATFORM}" \
        "${BUILD_TOOLS}"

# ============================================================
# BUILDER
# ============================================================

WORKDIR /builder

RUN git clone --depth 1 \
    https://github.com/xchacha20-poly1305/webview-apk-template.git \
    /builder/template

# ============================================================
# NODE API
# ============================================================

COPY package.json ./

RUN npm install --omit=dev

COPY server.js ./

# ============================================================
# DIRECTORIES
# ============================================================

RUN mkdir -p \
    /builder/jobs \
    /builder/builds \
    /builder/.gradle

ENV NODE_ENV=production
ENV PORT=10000
ENV GRADLE_USER_HOME=/builder/.gradle

EXPOSE 10000

# ============================================================
# START SERVER
# ============================================================

CMD ["node", "server.js"]
