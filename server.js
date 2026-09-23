const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = "/builder";
const TEMPLATE = path.join(ROOT, "template");
const JOBS_DIR = path.join(ROOT, "jobs");
const BUILDS_DIR = path.join(ROOT, "builds");

const API_KEY = process.env.BUILDER_API_KEY || "";

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ============================================================
// HELPERS
// ============================================================

function log(id, message) {
  console.log(`[BUILD ${id}] ${message}`);
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function saveJob(job) {
  fs.writeFileSync(
    path.join(JOBS_DIR, `${job.id}.json`),
    JSON.stringify(job, null, 2)
  );
}

function loadJob(id) {
  const file = path.join(JOBS_DIR, `${id}.json`);

  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(file, "utf8")
  );
}

function updateJob(job, values = {}) {
  Object.assign(job, values);

  job.updatedAt = new Date().toISOString();

  saveJob(job);
}

function validateUrl(value) {
  try {
    const u = new URL(value);

    if (u.protocol !== "https:") {
      return false;
    }

    if (u.username || u.password) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function validatePackage(value) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(
    value
  );
}

function cleanName(value) {
  return String(value || "Generated App")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim()
    .slice(0, 80) || "Generated App";
}

function cleanVersion(value) {
  return String(value || "1.0.0")
    .replace(/[^0-9A-Za-z._-]/g, "")
    .slice(0, 30) || "1.0.0";
}

// ============================================================
// GRADLE
// ============================================================

function runGradle(job) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    log(job.id, "========================================");
    log(job.id, "START GRADLE");
    log(job.id, "========================================");

    const gradle = spawn(
      "./gradlew",
      [
        "assembleDebug",
        "--no-daemon",
        "--console=plain",
        "--stacktrace"
      ],
      {
        cwd: TEMPLATE,

        env: {
          ...process.env,

          GRADLE_USER_HOME:
            "/builder/.gradle",

          JAVA_TOOL_OPTIONS:
            `${process.env.JAVA_TOOL_OPTIONS || ""} -Dorg.gradle.caching=true`
        }
      }
    );

    let stderr = "";

    // --------------------------------------------------------
    // GRADLE STDOUT
    // --------------------------------------------------------

    gradle.stdout.on("data", (data) => {
      const text = data.toString();

      process.stdout.write(
        `[GRADLE ${job.id}] ${text}`
      );
    });

    // --------------------------------------------------------
    // GRADLE STDERR
    // --------------------------------------------------------

    gradle.stderr.on("data", (data) => {
      const text = data.toString();

      stderr += text;

      process.stderr.write(
        `[GRADLE-ERR ${job.id}] ${text}`
      );
    });

    // --------------------------------------------------------
    // PROCESS ERROR
    // --------------------------------------------------------

    gradle.on("error", (error) => {
      reject(error);
    });

    // --------------------------------------------------------
    // PROCESS END
    // --------------------------------------------------------

    gradle.on("close", (code) => {
      const seconds = (
        (Date.now() - start) /
        1000
      ).toFixed(1);

      log(
        job.id,
        `Gradle finished with code ${code}`
      );

      log(
        job.id,
        `Gradle duration: ${seconds}s`
      );

      if (code !== 0) {
        reject(
          new Error(
            `Gradle failed with exit code ${code}\n${stderr.slice(-12000)}`
          )
        );

        return;
      }

      resolve();
    });
  });
}

// ============================================================
// BUILD PROCESS
// ============================================================

async function processBuild(job) {
  const start = Date.now();

  try {
    log(
      job.id,
      "========================================"
    );

    log(
      job.id,
      "GABINAROU APK BUILD START"
    );

    log(
      job.id,
      "========================================"
    );

    log(
      job.id,
      `URL: ${job.url}`
    );

    log(
      job.id,
      `Name: ${job.name}`
    );

    log(
      job.id,
      `Package: ${job.packageName}`
    );

    log(
      job.id,
      `Version: ${job.versionName}`
    );

    log(
      job.id,
      `Icon: ${job.iconUrl || "(none)"}`
    );

    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    updateJob(job, {
      status: "building",
      progress: 20
    });

    // --------------------------------------------------------
    // APP PROPERTIES
    // --------------------------------------------------------

    log(
      job.id,
      "Writing app.properties..."
    );

    const properties = [
      `app.url=${job.url}`,
      `app.package=${job.packageName}`,
      `app.name=${job.name}`,
      `app.icon_url=${job.iconUrl || ""}`
    ].join("\n") + "\n";

    fs.writeFileSync(
      path.join(
        TEMPLATE,
        "app.properties"
      ),
      properties
    );

    log(
      job.id,
      "app.properties written."
    );

    updateJob(job, {
      progress: 25
    });

    // --------------------------------------------------------
    // CHECK GRADLE
    // --------------------------------------------------------

    log(
      job.id,
      "Checking Gradle wrapper..."
    );

    const gradlePath =
      path.join(
        TEMPLATE,
        "gradlew"
      );

    if (!fs.existsSync(gradlePath)) {
      throw new Error(
        "gradlew not found in Android template."
      );
    }

    fs.chmodSync(
      gradlePath,
      0o755
    );

    log(
      job.id,
      "Gradle wrapper OK."
    );

    updateJob(job, {
      progress: 30
    });

    // --------------------------------------------------------
    // START BUILD
    // --------------------------------------------------------

    log(
      job.id,
      "Starting Android build..."
    );

    updateJob(job, {
      progress: 35
    });

    await runGradle(job);

    updateJob(job, {
      progress: 85
    });

    // --------------------------------------------------------
    // FIND APK
    // --------------------------------------------------------

    const apkSource =
      path.join(
        TEMPLATE,
        "app/build/outputs/apk/debug/app-debug.apk"
      );

    if (!fs.existsSync(apkSource)) {
      throw new Error(
        "Gradle finished successfully but app-debug.apk was not found."
      );
    }

    // --------------------------------------------------------
    // BUILD DIRECTORY
    // --------------------------------------------------------

    const buildDir =
      path.join(
        BUILDS_DIR,
        job.id
      );

    fs.mkdirSync(
      buildDir,
      {
        recursive: true
      }
    );

    // --------------------------------------------------------
    // COPY APK
    // --------------------------------------------------------

    const apkTarget =
      path.join(
        buildDir,
        `${job.packageName}-debug.apk`
      );

    fs.copyFileSync(
      apkSource,
      apkTarget
    );

    const apkSize =
      fs.statSync(apkTarget).size;

    log(
      job.id,
      `APK generated: ${apkTarget}`
    );

    log(
      job.id,
      `APK size: ${apkSize} bytes`
    );

    updateJob(job, {
      progress: 90
    });

    // --------------------------------------------------------
    // ZIP
    // --------------------------------------------------------

    log(
      job.id,
      "Creating ZIP..."
    );

    const zipName =
      `${job.packageName}-${job.versionName}.zip`;

    const zipPath =
      path.join(
        buildDir,
        zipName
      );

    await new Promise(
      (resolve, reject) => {

        const zip =
          spawn(
            "zip",
            [
              "-j",
              zipPath,
              apkTarget
            ],
            {
              cwd: buildDir
            }
          );

        let errorOutput = "";

        zip.stdout.on(
          "data",
          (data) => {
            process.stdout.write(
              `[ZIP ${job.id}] ${data}`
            );
          }
        );

        zip.stderr.on(
          "data",
          (data) => {

            errorOutput +=
              data.toString();

            process.stderr.write(
              `[ZIP-ERR ${job.id}] ${data}`
            );
          }
        );

        zip.on(
          "error",
          reject
        );

        zip.on(
          "close",
          (code) => {

            if (code !== 0) {

              reject(
                new Error(
                  `ZIP failed with code ${code}\n${errorOutput}`
                )
              );

              return;
            }

            resolve();
          }
        );
      }
    );

    log(
      job.id,
      `ZIP created: ${zipPath}`
    );

    updateJob(job, {
      progress: 95
    });

    // --------------------------------------------------------
    // COMPLETE
    // --------------------------------------------------------

    const totalSeconds =
      (
        (Date.now() - start) /
        1000
      ).toFixed(1);

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      `http://localhost:${PORT}`;

    const downloadUrl =
      `${baseUrl}/api/download/${job.id}`;

    updateJob(job, {

      status: "completed",

      progress: 100,

      apk:
        `${downloadUrl}?file=apk`,

      zip:
        `${downloadUrl}?file=zip`,

      downloadUrl,

      buildSeconds:
        Number(totalSeconds),

      error: null

    });

    log(
      job.id,
      "========================================"
    );

    log(
      job.id,
      "BUILD COMPLETED"
    );

    log(
      job.id,
      `Duration: ${totalSeconds}s`
    );

    log(
      job.id,
      `Download: ${downloadUrl}`
    );

    log(
      job.id,
      "========================================"
    );

  } catch (error) {

    const totalSeconds =
      (
        (Date.now() - start) /
        1000
      ).toFixed(1);

    console.error(
      `[BUILD ${job.id}] BUILD FAILED after ${totalSeconds}s`
    );

    console.error(
      error.stack || error
    );

    updateJob(job, {

      status: "failed",

      progress: 100,

      error:
        error.message,

      buildSeconds:
        Number(totalSeconds)

    });
  }
}

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.json({

      success: true,

      service:
        "gabinarou-webview-apk-builder",

      version:
        "3.0.0",

      status:
        "online"

    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      success: true,

      service:
        "gabinarou-webview-apk-builder",

      version:
        "3.0.0",

      status:
        "online",

      time:
        new Date().toISOString()

    });
  }
);

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      success: true,

      service:
        "gabinarou-webview-apk-builder",

      version:
        "3.0.0",

      status:
        "online",

      time:
        new Date().toISOString()

    });
  }
);

// ============================================================
// CREATE BUILD
// ============================================================

app.post(
  "/api/build",
  (req, res) => {

    // --------------------------------------------------------
    // API KEY
    // --------------------------------------------------------

    if (API_KEY) {

      const provided =
        req.headers["x-api-key"] ||
        req.headers.authorization?.replace(
          /^Bearer\s+/i,
          ""
        );

      if (provided !== API_KEY) {

        return res
          .status(401)
          .json({

            success: false,

            error:
              "Unauthorized"

          });
      }
    }

    const body =
      req.body || {};

    // --------------------------------------------------------
    // INPUTS
    // --------------------------------------------------------

    const url =
      body.url ||
      body.appUrl;

    const name =
      cleanName(
        body.name ||
        body.appName
      );

    const packageName =
      body.packageName ||
      body.packageId ||
      "com.gabinarou.generatedapp";

    const iconUrl =
      body.iconUrl ||
      "";

    const versionName =
      cleanVersion(
        body.version ||
        body.versionName
      );

    // --------------------------------------------------------
    // URL VALIDATION
    // --------------------------------------------------------

    if (
      !url ||
      !validateUrl(url)
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            "A valid HTTPS URL is required."

        });
    }

    // --------------------------------------------------------
    // PACKAGE VALIDATION
    // --------------------------------------------------------

    if (
      !validatePackage(
        packageName
      )
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            "Invalid Android package name."

        });
    }

    // --------------------------------------------------------
    // ICON VALIDATION
    // --------------------------------------------------------

    if (
      iconUrl &&
      (
        !iconUrl.startsWith(
          "https://"
        ) ||
        iconUrl.includes("\n") ||
        iconUrl.includes("\r")
      )
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            "iconUrl must be HTTPS."

        });
    }

    // --------------------------------------------------------
    // JOB
    // --------------------------------------------------------

    const id =
      makeId();

    const job = {

      id,

      status:
        "queued",

      progress:
        5,

      url,

      name,

      packageName,

      iconUrl,

      versionName,

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString(),

      downloadUrl:
        null,

      apk:
        null,

      zip:
        null,

      error:
        null

    };

    saveJob(job);

    console.log("");

    console.log(
      "========================================"
    );

    console.log(
      `NEW BUILD JOB: ${id}`
    );

    console.log(
      "========================================"
    );

    // --------------------------------------------------------
    // START ASYNC BUILD
    // --------------------------------------------------------

    processBuild(job);

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    res
      .status(202)
      .json({

        success: true,

        jobId:
          id,

        status:
          "queued",

        statusUrl:
          `/api/build/${id}`

      });
  }
);

// ============================================================
// BUILD STATUS
// ============================================================

app.get(
  "/api/build/:id",
  (req, res) => {

    const job =
      loadJob(
        req.params.id
      );

    if (!job) {

      return res
        .status(404)
        .json({

          success: false,

          error:
            "Build job not found"

        });
    }

    res.json({

      success: true,

      ...job

    });
  }
);

// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  "/api/download/:id",
  (req, res) => {

    const job =
      loadJob(
        req.params.id
      );

    if (!job) {

      return res
        .status(404)
        .json({

          success: false,

          error:
            "Build job not found"

        });
    }

    if (
      job.status !==
      "completed"
    ) {

      return res
        .status(409)
        .json({

          success: false,

          error:
            "Build is not completed.",

          status:
            job.status,

          progress:
            job.progress

        });
    }

    const buildDir =
      path.join(
        BUILDS_DIR,
        job.id
      );

    const apkPath =
      path.join(
        buildDir,
        `${job.packageName}-debug.apk`
      );

    const zipPath =
      path.join(
        buildDir,
        `${job.packageName}-${job.versionName}.zip`
      );

    const file =
      req.query.file ||
      "zip";

    // --------------------------------------------------------
    // APK
    // --------------------------------------------------------

    if (
      file === "apk"
    ) {

      if (
        !fs.existsSync(
          apkPath
        )
      ) {

        return res
          .status(404)
          .json({

            success: false,

            error:
              "APK file not found."

          });
      }

      return res.download(
        apkPath,
        `${job.name.replace(
          /\s+/g,
          "_"
        )}.apk`
      );
    }

    // --------------------------------------------------------
    // ZIP
    // --------------------------------------------------------

    if (
      !fs.existsSync(
        zipPath
      )
    ) {

      return res
        .status(404)
        .json({

          success: false,

          error:
            "ZIP file not found."

        });
    }

    return res.download(
      zipPath,
      `${job.name.replace(
        /\s+/g,
        "_"
      )}.zip`
    );
  }
);

// ============================================================
// SERVER
// ============================================================

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      "========================================"
    );

    console.log(
      " Gabinarou WebView APK Builder v3"
    );

    console.log(
      "========================================"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `Host: ${HOST}`
    );

    console.log(
      "API:  /api/build"
    );

    console.log(
      "Health: /health"
    );

    console.log(
      "Gradle logs: ENABLED"
    );

    console.log(
      "========================================"
    );
  }
);
