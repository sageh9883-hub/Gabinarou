FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# ============================================================
# ANDROID
# ============================================================

ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk

# ============================================================
# GRADLE
# ============================================================

ENV GRADLE_VERSION=9.7.1
ENV GRADLE_HOME=/opt/gradle/gradle-9.7.1

ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/gradle/gradle-9.7.1/bin:$PATH

# ============================================================
# MEMORY LIMITS
# ============================================================

ENV NODE_OPTIONS="--max-old-space-size=96"

ENV JAVA_TOOL_OPTIONS="-Xms32m -Xmx160m -XX:MaxMetaspaceSize=64m -XX:ReservedCodeCacheSize=32m -XX:+UseSerialGC -XX:ActiveProcessorCount=1"

ENV GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xms32m -Xmx160m -XX:MaxMetaspaceSize=64m -XX:ReservedCodeCacheSize=32m -XX:+UseSerialGC -XX:ActiveProcessorCount=1 -Dorg.gradle.parallel=false -Dorg.gradle.workers.max=1 -Dorg.gradle.caching=false -Dorg.gradle.configuration-cache=false -Dorg.gradle.vfs.watch=false -Dkotlin.compiler.execution.strategy=in-process -Dkotlin.daemon.enabled=false -Dfile.encoding=UTF-8"

# ============================================================
# SERVER
# ============================================================

ENV NODE_ENV=production
ENV PORT=10000
ENV GRADLE_USER_HOME=/builder/.gradle

# ============================================================
# SYSTEM PACKAGES
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
    procps \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# ANDROID COMMAND LINE TOOLS
# ============================================================

RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools

RUN wget -q \
    https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip \
    -O /tmp/cmdline-tools.zip \
    && unzip -q \
       /tmp/cmdline-tools.zip \
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
    echo "============================================"; \
    echo "ANDROID 37 AVAILABLE PACKAGES"; \
    grep -E 'platforms;android-37|build-tools;37' /tmp/sdk-list || true; \
    echo "============================================"; \
    PLATFORM="$(grep -oE 'platforms;android-37([.]?[0-9]+)?' /tmp/sdk-list | sort -V | tail -1)"; \
    BUILD_TOOLS="$(grep -oE 'build-tools;37[.][0-9]+[.][0-9]+' /tmp/sdk-list | sort -V | tail -1)"; \
    echo "Selected platform: ${PLATFORM}"; \
    echo "Selected build tools: ${BUILD_TOOLS}"; \
    test -n "${PLATFORM}"; \
    test -n "${BUILD_TOOLS}"; \
    yes | sdkmanager --channel=3 \
        "platform-tools" \
        "${PLATFORM}" \
        "${BUILD_TOOLS}"

# ============================================================
# GRADLE 9.7.1
# ============================================================

RUN mkdir -p /opt/gradle

RUN wget -q \
    https://services.gradle.org/distributions/gradle-9.7.1-bin.zip \
    -O /tmp/gradle.zip \
    && unzip -q \
       /tmp/gradle.zip \
       -d /opt/gradle \
    && rm -f /tmp/gradle.zip

# ============================================================
# VERIFY GRADLE
# ============================================================

RUN /opt/gradle/gradle-9.7.1/bin/gradle --version

# ============================================================
# BUILDER DIRECTORY
# ============================================================

WORKDIR /builder

# ============================================================
# WEBVIEW TEMPLATE
# ============================================================

RUN git clone --depth 1 \
    https://github.com/xchacha20-poly1305/webview-apk-template.git \
    /builder/template

# ============================================================
# NODE
# ============================================================

COPY package.json ./

RUN npm install --omit=dev

# ============================================================
# SERVER
# ============================================================

COPY server.js ./

# ============================================================
# DIRECTORIES
# ============================================================

RUN mkdir -p \
    /builder/jobs \
    /builder/builds \
    /builder/workspaces \
    /builder/.gradle

# ============================================================
# GLOBAL GRADLE PROPERTIES
# ============================================================

RUN printf '%s\n' \
    'org.gradle.daemon=false' \
    'org.gradle.parallel=false' \
    'org.gradle.workers.max=1' \
    'org.gradle.caching=false' \
    'org.gradle.configuration-cache=false' \
    'org.gradle.vfs.watch=false' \
    'kotlin.compiler.execution.strategy=in-process' \
    'kotlin.daemon.enabled=false' \
    'android.builder.sdkDownload=false' \
    'org.gradle.jvmargs=-Xms32m -Xmx160m -XX:MaxMetaspaceSize=64m -XX:ReservedCodeCacheSize=32m -XX:+UseSerialGC -XX:ActiveProcessorCount=1' \
    > /builder/.gradle/gradle.properties

# ============================================================
# ENVIRONMENT VERIFICATION
# ============================================================

RUN echo "============================================" \
    && echo "JAVA VERSION" \
    && java -version \
    && echo "============================================" \
    && echo "GRADLE VERSION" \
    && /opt/gradle/gradle-9.7.1/bin/gradle --version \
    && echo "============================================" \
    && echo "ANDROID SDK" \
    && ls -la /opt/android-sdk \
    && echo "============================================" \
    && echo "TEMPLATE" \
    && ls -la /builder/template \
    && echo "============================================"

# ============================================================
# NETWORK
# ============================================================

EXPOSE 10000

# ============================================================
# START
# ============================================================

CMD ["node", "server.js"]
