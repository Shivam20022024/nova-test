FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

WORKDIR /app

# ── Android tooling for the mobile testing engine (backend/mobile) ──────
# Only two binaries are actually needed here:
#   adb   — device discovery (device_manager.list_adb_devices) and screen
#           recording (video.py). It is a *client*: devices are reached over
#           the network with `adb connect host:port`, so no USB, no emulator
#           and no KVM in this container.
#   aapt  — static APK metadata extraction (apk_inspector). Not optional:
#           without it every APK upload fails with ApkValidationError.
# Appium itself is deliberately NOT installed — it runs on an external host
# (APPIUM_HOST + APPIUM_START_ON_DEMAND=false), which keeps Node and the
# whole Android SDK out of this image. Adds roughly 100-150MB.
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:/opt/android-sdk/platform-tools"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && mkdir -p "${ANDROID_HOME}" \
    && curl -fsSL -o /tmp/platform-tools.zip \
         https://dl.google.com/android/repository/platform-tools-latest-linux.zip \
    && unzip -q /tmp/platform-tools.zip -d "${ANDROID_HOME}" \
    && curl -fsSL -o /tmp/build-tools.zip \
         https://dl.google.com/android/repository/build-tools_r34-linux.zip \
    && unzip -q /tmp/build-tools.zip -d /tmp/build-tools \
    && mkdir -p "${ANDROID_HOME}/build-tools" \
    # The r34 archive unpacks as "android-14"; apk_inspector globs
    # ANDROID_HOME/build-tools/*/aapt, so the directory name only has to be
    # stable, not semantic. Move whatever it produced into a fixed name.
    && mv /tmp/build-tools/* "${ANDROID_HOME}/build-tools/34.0.0" \
    && rm -rf /tmp/platform-tools.zip /tmp/build-tools.zip /tmp/build-tools \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && adb version \
    && "${ANDROID_HOME}/build-tools/34.0.0/aapt" version

COPY requirements.txt .

# Install python dependencies (Playwright browsers are already installed in this base image)
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
EXPOSE 8001

CMD ["python", "start.py"]
