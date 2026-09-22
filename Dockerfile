FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/37.0.0

# ==========================================
# SYSTEM DEPENDENCIES
# ==========================================

RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    nodejs \
    npm \
    wget \
    unzip \
    git \
    curl \
    zip \
    ca-certificates \
    bash \
    && rm -rf /var/lib/apt/lists/*

# ==========================================
# ANDROID SDK
# ==========================================

RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools

RUN wget -q https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
    -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools \
    && mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip

RUN yes | sdkmanager --licenses >/dev/null || true

RUN sdkmanager \
    "platform-tools" \
    "platforms;android-37" \
    "build-tools;37.0.0"

# ==========================================
# BUILDER
# ==========================================

WORKDIR /builder

RUN git clone --depth 1 \
    https://github.com/xchacha20-poly1305/webview-apk-template.git \
    template

COPY build.sh /builder/build.sh
RUN chmod +x /builder/build.sh

# ==========================================
# NODE SERVER
# ==========================================

COPY package.json /builder/package.json
COPY server.js /builder/server.js

RUN npm install --omit=dev

# ==========================================
# START SERVER
# ==========================================

EXPOSE 10000

CMD ["node", "/builder/server.js"]

Et il faut aussi "package.json"

À la racine de ton dépôt, crée/remplace :
