const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = "/builder";

const TEMPLATE = path.join(
  ROOT,
  "template"
);

const JOBS_DIR = path.join(
  ROOT,
  "jobs"
);

const BUILDS_DIR = path.join(
  ROOT,
  "builds"
);

const WORKSPACES_DIR = path.join(
  ROOT,
  "workspaces"
);

const API_KEY =
  process.env.BUILDER_API_KEY || "";

// Gradle timeout: 10 minutes
const GRADLE_TIMEOUT =
  Number(
    process.env.GRADLE_TIMEOUT_MS ||
    10 * 60 * 1000
  );

// ============================================================
// DIRECTORIES
// ============================================================

fs.mkdirSync(
  JOBS_DIR,
  {
    recursive: true
  }
);

fs.mkdirSync(
  BUILDS_DIR,
  {
    recursive: true
  }
);

fs.mkdirSync(
  WORKSPACES_DIR,
  {
    recursive: true
  }
);

// ============================================================
// EXPRESS
// ============================================================

app.use(
  helmet()
);

app.use(
  cors()
);

app.use(
  express.json({
    limit: "2mb"
  })
);

// ============================================================
// PROCESS DIAGNOSTICS
// ============================================================

process.on(
  "exit",
  (code) => {
    console.log(
      `[PROCESS] Node exiting with code ${code}`
    );
  }
);

process.on(
  "SIGTERM",
  () => {
    console.error(
      "[PROCESS] SIGTERM received"
    );
  }
);

process.on(
  "SIGINT",
  () => {
    console.error(
      "[PROCESS] SIGINT received"
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[PROCESS] UNCAUGHT EXCEPTION"
    );

    console.error(
      error.stack || error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[PROCESS] UNHANDLED REJECTION"
    );

    console.error(
      reason
    );
  }
);

// ============================================================
// BUILD QUEUE
// ============================================================
//
// Important on Render Free:
// We only allow one Android/Gradle build at a time.
// This avoids two Gradle JVMs consuming the 512 MB RAM
// simultaneously.
//

let buildQueue = Promise.resolve();

function queueBuild(job) {

  const current =
    buildQueue.then(
      async () => {
        return processBuild(job);
      }
    );

  buildQueue =
    current.catch(
      (error) => {
        console.error(
          `[QUEUE ${job.id}] ${error.stack || error}`
        );
      }
    );

  return current;
}

// ============================================================
// LOGGING
// ============================================================

function log(
  id,
  message
) {
  console.log(
    `[BUILD ${id}] ${message}`
  );
}

// ============================================================
// HELPERS
// ============================================================

function makeId() {
  return crypto
    .randomBytes(12)
    .toString("hex");
}

function saveJob(job) {

  fs.writeFileSync(
    path.join(
      JOBS_DIR,
      `${job.id}.json`
    ),
    JSON.stringify(
      job,
      null,
      2
    )
  );
}

function loadJob(id) {

  const file =
    path.join(
      JOBS_DIR,
      `${id}.json`
    );

  if (
    !fs.existsSync(file)
  ) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(
      file,
      "utf8"
    )
  );
}

function updateJob(
  job,
  values = {}
) {

  Object.assign(
    job,
    values
  );

  job.updatedAt =
    new Date().toISOString();

  saveJob(job);
}

function validateUrl(
  value
) {

  try {

    const u =
      new URL(value);

    if (
      u.protocol !==
      "https:"
    ) {
      return false;
    }

    if (
      u.username ||
      u.password
    ) {
      return false;
    }

    return true;

  } catch {

    return false;
  }
}

function validatePackage(
  value
) {

  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(
    value
  );
}

function cleanName(
  value
) {

  return String(
    value ||
    "Generated App"
  )
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      ""
    )
    .trim()
    .slice(
      0,
      80
    ) ||
    "Generated App";
}

function cleanVersion(
  value
) {

  return String(
    value ||
    "1.0.0"
  )
    .replace(
      /[^0-9A-Za-z._-]/g,
      ""
    )
    .slice(
      0,
      30
    ) ||
    "1.0.0";
}

// ============================================================
// MEMORY DIAGNOSTICS
// ============================================================

function memoryInfo() {

  const mem =
    process.memoryUsage();

  return (
    `RSS=${Math.round(
      mem.rss / 1024 / 1024
    )}MB ` +
    `HeapUsed=${Math.round(
      mem.heapUsed / 1024 / 1024
    )}MB ` +
    `HeapTotal=${Math.round(
      mem.heapTotal / 1024 / 1024
    )}MB ` +
    `External=${Math.round(
      mem.external / 1024 / 1024
    )}MB`
  );
}

function logSystemInfo(
  job
) {

  log(
    job.id,
    `Node memory: ${memoryInfo()}`
  );

  try {

    const load =
      require("os").loadavg();

    log(
      job.id,
      `Load average: ${load.join(", ")}`
    );

  } catch (error) {

    log(
      job.id,
      `Could not read load average: ${
        error.message
      }`
    );
  }
}

// ============================================================
// COPY TEMPLATE
// ============================================================

function copyTemplateForJob(
  job
) {

  const workspace =
    path.join(
      WORKSPACES_DIR,
      job.id
    );

  log(
    job.id,
    `Creating isolated workspace: ${workspace}`
  );

  if (
    fs.existsSync(workspace)
  ) {

    fs.rmSync(
      workspace,
      {
        recursive: true,
        force: true
      }
    );
  }

  fs.mkdirSync(
    workspace,
    {
      recursive: true
    }
  );

  // Node 20 supports fs.cpSync.
  //
  // We intentionally don't copy previous Gradle build
  // outputs or the local .gradle directory.

  fs.cpSync(
    TEMPLATE,
    workspace,
    {
      recursive: true,
      filter: (source) => {

        const relative =
          path.relative(
            TEMPLATE,
            source
          );

        if (
          !relative
        ) {
          return true;
        }

        const parts =
          relative.split(
            path.sep
          );

        if (
          parts.includes(
            ".gradle"
          )
        ) {
          return false;
        }

        if (
          parts.includes(
            "build"
          )
        ) {
          return false;
        }

        return true;
      }
    }
  );

  log(
    job.id,
    "Android template copied successfully."
  );

  return workspace;
}

// ============================================================
// GRADLE
// ============================================================

function runGradle(
  job,
  workspace
) {

  return new Promise(
    (resolve, reject) => {

      const start =
        Date.now();

      log(
        job.id,
        "========================================"
      );

      log(
        job.id,
        "GRADLE DIAGNOSTIC START"
      );

      log(
        job.id,
        "========================================"
      );

      logSystemInfo(
        job
      );

      const gradlePath =
        path.join(
          workspace,
          "gradlew"
        );

      log(
        job.id,
        `Gradle executable: ${gradlePath}`
      );

      log(
        job.id,
        `Gradle cwd: ${workspace}`
      );

      log(
        job.id,
        `Gradle timeout: ${GRADLE_TIMEOUT}ms`
      );

      log(
        job.id,
        "Step 1: verifying gradlew..."
      );

      if (
        !fs.existsSync(
          gradlePath
        )
      ) {

        reject(
          new Error(
            `gradlew not found: ${gradlePath}`
          )
        );

        return;
      }

      try {

        fs.chmodSync(
          gradlePath,
          0o755
        );

      } catch (error) {

        reject(
          new Error(
            `Unable to chmod gradlew: ${
              error.message
            }`
          )
        );

        return;
      }

      log(
        job.id,
        "Step 2: gradlew exists and is executable."
      );

      const args = [
        "assembleDebug",
        "--no-daemon",
        "--console=plain",
        "--stacktrace",
        "--max-workers=1"
      ];

      log(
        job.id,
        `Step 3: about to launch Gradle: ./gradlew ${args.join(
          " "
        )}`
      );

      log(
        job.id,
        `Step 4: cwd = ${workspace}`
      );

      log(
        job.id,
        `Step 5: GRADLE_USER_HOME = /builder/.gradle`
      );

      log(
        job.id,
        "Step 6: spawning Gradle process..."
      );

      let gradle;

      try {

        gradle =
          spawn(
            "./gradlew",
            args,
            {
              cwd: workspace,

              env: {
                ...process.env,

                GRADLE_USER_HOME:
                  "/builder/.gradle",

                JAVA_TOOL_OPTIONS:
                  "-Xmx256m -XX:MaxMetaspaceSize=128m",

                GRADLE_OPTS:
                  "-Dorg.gradle.jvmargs=-Xmx256m -Dorg.gradle.daemon=false"
              },

              stdio: [
                "ignore",
                "pipe",
                "pipe"
              ]
            }
          );

      } catch (error) {

        console.error(
          `[BUILD ${job.id}] spawn() THREW SYNCHRONOUSLY`
        );

        console.error(
          error.stack || error
        );

        reject(error);

        return;
      }

      log(
        job.id,
        "Step 7: Gradle child process CREATED."
      );

      log(
        job.id,
        `Gradle PID: ${gradle.pid || "unknown"}`
      );

      let stderr = "";
      let stdout = "";

      let settled = false;
      let timedOut = false;

      const timer =
        setTimeout(
          () => {

            if (
              settled
            ) {
              return;
            }

            timedOut = true;

            console.error(
              `[BUILD ${job.id}] GRADLE TIMEOUT`
            );

            log(
              job.id,
              `Gradle exceeded ${GRADLE_TIMEOUT}ms.`
            );

            try {

              gradle.kill(
                "SIGTERM"
              );

              log(
                job.id,
                "SIGTERM sent to Gradle."
              );

            } catch (error) {

              console.error(
                `[BUILD ${job.id}] Could not SIGTERM Gradle`
              );

              console.error(
                error.stack || error
              );
            }

            setTimeout(
              () => {

                if (
                  settled
                ) {
                  return;
                }

                try {

                  gradle.kill(
                    "SIGKILL"
                  );

                  log(
                    job.id,
                    "SIGKILL sent to Gradle."
                  );

                } catch (error) {

                  console.error(
                    `[BUILD ${job.id}] Could not SIGKILL Gradle`
                  );

                  console.error(
                    error.stack || error
                  );
                }

              },
              10000
            );

          },
          GRADLE_TIMEOUT
        );

      // ------------------------------------------------------
      // STDOUT
      // ------------------------------------------------------

      gradle.stdout.on(
        "data",
        (data) => {

          const text =
            data.toString();

          stdout += text;

          process.stdout.write(
            `[GRADLE ${job.id}] ${text}`
          );
        }
      );

      // ------------------------------------------------------
      // STDERR
      // ------------------------------------------------------

      gradle.stderr.on(
        "data",
        (data) => {

          const text =
            data.toString();

          stderr += text;

          process.stderr.write(
            `[GRADLE-ERR ${job.id}] ${text}`
          );
        }
      );

      // ------------------------------------------------------
      // SPAWN ERROR
      // ------------------------------------------------------

      gradle.on(
        "error",
        (error) => {

          console.error(
            `[BUILD ${job.id}] GRADLE PROCESS ERROR`
          );

          console.error(
            error.stack || error
          );

          if (
            !settled
          ) {

            settled = true;

            clearTimeout(
              timer
            );

            reject(
              error
            );
          }
        }
      );

      // ------------------------------------------------------
      // EXIT
      // ------------------------------------------------------

      gradle.on(
        "exit",
        (code, signal) => {

          log(
            job.id,
            `Gradle EXIT event: code=${code}, signal=${
              signal || "none"
            }`
          );
        }
      );

      // ------------------------------------------------------
      // CLOSE
      // ------------------------------------------------------

      gradle.on(
        "close",
        (code, signal) => {

          if (
            settled
          ) {
            return;
          }

          settled = true;

          clearTimeout(
            timer
          );

          const seconds =
            (
              (Date.now() - start) /
              1000
            ).toFixed(1);

          log(
            job.id,
            "========================================"
          );

          log(
            job.id,
            "GRADLE PROCESS CLOSED"
          );

          log(
            job.id,
            `Exit code: ${code}`
          );

          log(
            job.id,
            `Signal: ${signal || "none"}`
          );

          log(
            job.id,
            `Duration: ${seconds}s`
          );

          logSystemInfo(
            job
          );

          if (
            timedOut
          ) {

            reject(
              new Error(
                `Gradle build timed out after ${
                  GRADLE_TIMEOUT
                }ms.`
              )
            );

            return;
          }

          if (
            code !== 0
          ) {

            let details =
              stderr.slice(
                -15000
              );

            if (
              !details.trim()
            ) {
              details =
                stdout.slice(
                  -15000
                );
            }

            reject(
              new Error(
                `Gradle failed with exit code ${code}` +
                `${
                  signal
                    ? `, signal ${signal}`
                    : ""
                }` +
                `\n\n${details}`
              )
            );

            return;
          }

          log(
            job.id,
            "Gradle build completed successfully."
          );

          resolve();
        }
      );
    }
  );
}

// ============================================================
// ZIP
// ============================================================

function createZip(
  job,
  apkTarget,
  zipPath,
  buildDir
) {

  return new Promise(
    (resolve, reject) => {

      log(
        job.id,
        "Creating ZIP..."
      );

      log(
        job.id,
        `ZIP output: ${zipPath}`
      );

      const zip =
        spawn(
          "zip",
          [
            "-j",
            zipPath,
            apkTarget
          ],
          {
            cwd: buildDir,
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );

      let errorOutput = "";

      log(
        job.id,
        `ZIP process PID: ${
          zip.pid || "unknown"
        }`
      );

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

          const text =
            data.toString();

          errorOutput += text;

          process.stderr.write(
            `[ZIP-ERR ${job.id}] ${text}`
          );
        }
      );

      zip.on(
        "error",
        (error) => {

          console.error(
            `[BUILD ${job.id}] ZIP PROCESS ERROR`
          );

          console.error(
            error.stack || error
          );

          reject(error);
        }
      );

      zip.on(
        "exit",
        (code, signal) => {

          log(
            job.id,
            `ZIP exit: code=${code}, signal=${
              signal || "none"
            }`
          );
        }
      );

      zip.on(
        "close",
        (code) => {

          if (
            code !== 0
          ) {

            reject(
              new Error(
                `ZIP failed with code ${code}\n${errorOutput}`
              )
            );

            return;
          }

          log(
            job.id,
            "ZIP created successfully."
          );

          resolve();
        }
      );
    }
  );
}

// ============================================================
// CLEAN WORKSPACE
// ============================================================

function cleanupWorkspace(
  job,
  workspace
) {

  try {

    if (
      fs.existsSync(
        workspace
      )
    ) {

      fs.rmSync(
        workspace,
        {
          recursive: true,
          force: true
        }
      );

      log(
        job.id,
        "Temporary workspace cleaned."
      );
    }

  } catch (error) {

    console.error(
      `[BUILD ${job.id}] Workspace cleanup failed`
    );

    console.error(
      error.stack || error
    );
  }
}

// ============================================================
// BUILD PROCESS
// ============================================================

async function processBuild(
  job
) {

  const start =
    Date.now();

  let workspace =
    null;

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
      "VERSION 3.2.0"
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

    logSystemInfo(
      job
    );

    updateJob(
      job,
      {
        status:
          "building",
        progress:
          10
      }
    );

    // --------------------------------------------------------
    // TEMPLATE CHECK
    // --------------------------------------------------------

    log(
      job.id,
      "Step A: checking Android template..."
    );

    if (
      !fs.existsSync(
        TEMPLATE
      )
    ) {

      throw new Error(
        `Android template not found: ${TEMPLATE}`
      );
    }

    log(
      job.id,
      `Template found: ${TEMPLATE}`
    );

    updateJob(
      job,
      {
        progress:
          15
      }
    );

    // --------------------------------------------------------
    // ISOLATED WORKSPACE
    // --------------------------------------------------------

    log(
      job.id,
      "Step B: creating isolated build workspace..."
    );

    workspace =
      copyTemplateForJob(
        job
      );

    updateJob(
      job,
      {
        progress:
          20
      }
    );

    // --------------------------------------------------------
    // APP PROPERTIES
    // --------------------------------------------------------

    log(
      job.id,
      "Step C: writing app.properties..."
    );

    const properties = [
      `app.url=${job.url}`,
      `app.package=${job.packageName}`,
      `app.name=${job.name}`,
      `app.icon_url=${job.iconUrl || ""}`
    ].join("\n") + "\n";

    const propertiesPath =
      path.join(
        workspace,
        "app.properties"
      );

    fs.writeFileSync(
      propertiesPath,
      properties
    );

    log(
      job.id,
      `app.properties written: ${propertiesPath}`
    );

    log(
      job.id,
      "app.properties content:"
    );

    process.stdout.write(
      properties
    );

    updateJob(
      job,
      {
        progress:
          25
      }
    );

    // --------------------------------------------------------
    // GRADLE CHECK
    // --------------------------------------------------------

    log(
      job.id,
      "Step D: checking Gradle wrapper..."
    );

    const gradlePath =
      path.join(
        workspace,
        "gradlew"
      );

    if (
      !fs.existsSync(
        gradlePath
      )
    ) {

      throw new Error(
        `gradlew not found: ${gradlePath}`
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

    updateJob(
      job,
      {
        progress:
          30
      }
    );

    // --------------------------------------------------------
    // GRADLE
    // --------------------------------------------------------

    log(
      job.id,
      "Step E: about to launch Gradle."
    );

    log(
      job.id,
      "IMPORTANT: if the Render container dies now, the last visible log should be this step."
    );

    updateJob(
      job,
      {
        progress:
          35
      }
    );

    await runGradle(
      job,
      workspace
    );

    log(
      job.id,
      "Step F: Gradle returned successfully."
    );

    updateJob(
      job,
      {
        progress:
          82
      }
    );

    // --------------------------------------------------------
    // APK
    // --------------------------------------------------------

    log(
      job.id,
      "Step G: locating APK..."
    );

    const apkSource =
      path.join(
        workspace,
        "app",
        "build",
        "outputs",
        "apk",
        "debug",
        "app-debug.apk"
      );

    log(
      job.id,
      `Expected APK: ${apkSource}`
    );

    if (
      !fs.existsSync(
        apkSource
      )
    ) {

      throw new Error(
        "Gradle finished successfully but app-debug.apk was not found."
      );
    }

    const apkSourceSize =
      fs.statSync(
        apkSource
      ).size;

    log(
      job.id,
      `Source APK size: ${apkSourceSize} bytes`
    );

    // --------------------------------------------------------
    // BUILD DIRECTORY
    // --------------------------------------------------------

    log(
      job.id,
      "Step H: creating output directory..."
    );

    const buildDir =
      path.join(
        BUILDS_DIR,
        job.id
      );

    fs.mkdirSync(
      buildDir,
      {
        recursive:
          true
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

    log(
      job.id,
      `Copying APK to: ${apkTarget}`
    );

    fs.copyFileSync(
      apkSource,
      apkTarget
    );

    const apkSize =
      fs.statSync(
        apkTarget
      ).size;

    log(
      job.id,
      `APK generated successfully. Size=${apkSize} bytes`
    );

    updateJob(
      job,
      {
        progress:
          88
      }
    );

    // --------------------------------------------------------
    // ZIP
    // --------------------------------------------------------

    const zipName =
      `${job.packageName}-${job.versionName}.zip`;

    const zipPath =
      path.join(
        buildDir,
        zipName
      );

    log(
      job.id,
      "Step I: creating ZIP..."
    );

    await createZip(
      job,
      apkTarget,
      zipPath,
      buildDir
    );

    const zipSize =
      fs.statSync(
        zipPath
      ).size;

    log(
      job.id,
      `ZIP size: ${zipSize} bytes`
    );

    updateJob(
      job,
      {
        progress:
          95
      }
    );

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

    updateJob(
      job,
      {
        status:
          "completed",

        progress:
          100,

        apk:
          `${downloadUrl}?file=apk`,

        zip:
          `${downloadUrl}?file=zip`,

        downloadUrl,

        buildSeconds:
          Number(
            totalSeconds
          ),

        error:
          null
      }
    );

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
      `APK: ${downloadUrl}?file=apk`
    );

    log(
      job.id,
      `ZIP: ${downloadUrl}?file=zip`
    );

    log(
      job.id,
      "========================================"
    );

    logSystemInfo(
      job
    );

    return job;

  } catch (error) {

    const totalSeconds =
      (
        (Date.now() - start) /
        1000
      ).toFixed(1);

    console.error(
      `[BUILD ${job.id}] ========================================`
    );

    console.error(
      `[BUILD ${job.id}] BUILD FAILED`
    );

    console.error(
      `[BUILD ${job.id}] Duration: ${totalSeconds}s`
    );

    console.error(
      `[BUILD ${job.id}] Error:`
    );

    console.error(
      error.stack || error
    );

    try {

      updateJob(
        job,
        {
          status:
            "failed",

          progress:
            100,

          error:
            error.message ||
            String(error),

          buildSeconds:
            Number(
              totalSeconds
            )
        }
      );

    } catch (saveError) {

      console.error(
        `[BUILD ${job.id}] Could not save failed job`
      );

      console.error(
        saveError.stack || saveError
      );
    }

    return job;

  } finally {

    if (
      workspace
    ) {

      cleanupWorkspace(
        job,
        workspace
      );
    }

    log(
      job.id,
      `processBuild FINISHED. Final status=${job.status}`
    );
  }
}

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.json({
      success:
        true,

      service:
        "gabinarou-webview-apk-builder",

      version:
        "3.2.0",

      status:
        "online"
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

function healthResponse(
  req,
  res
) {

  res.json({
    success:
      true,

    service:
      "gabinarou-webview-apk-builder",

    version:
      "3.2.0",

    status:
      "online",

    time:
      new Date().toISOString(),

    memory:
      memoryInfo(),

    gradleTimeout:
      GRADLE_TIMEOUT
  });
}

app.get(
  "/health",
  healthResponse
);

app.get(
  "/api/health",
  healthResponse
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

    if (
      API_KEY
    ) {

      const provided =
        req.headers["x-api-key"] ||
        req.headers.authorization?.replace(
          /^Bearer\s+/i,
          ""
        );

      if (
        provided !==
        API_KEY
      ) {

        return res
          .status(401)
          .json({
            success:
              false,

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
    // URL
    // --------------------------------------------------------

    if (
      !url ||
      !validateUrl(url)
    ) {

      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "A valid HTTPS URL is required."
        });
    }

    // --------------------------------------------------------
    // PACKAGE
    // --------------------------------------------------------

    if (
      !validatePackage(
        packageName
      )
    ) {

      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Invalid Android package name."
        });
    }

    // --------------------------------------------------------
    // ICON
    // --------------------------------------------------------

    if (
      iconUrl &&
      (
        !iconUrl.startsWith(
          "https://"
        ) ||
        iconUrl.includes(
          "\n"
        ) ||
        iconUrl.includes(
          "\r"
        )
      )
    ) {

      return res
        .status(400)
        .json({
          success:
            false,

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

    saveJob(
      job
    );

    console.log("");

    console.log(
      "========================================"
    );

    console.log(
      `NEW BUILD JOB: ${id}`
    );

    console.log(
      `URL: ${url}`
    );

    console.log(
      `PACKAGE: ${packageName}`
    );

    console.log(
      "========================================"
    );

    // --------------------------------------------------------
    // QUEUE
    // --------------------------------------------------------

    queueBuild(
      job
    )
      .then(
        () => {

          console.log(
            `[BUILD ${id}] processBuild FINISHED`
          );
        }
      )
      .catch(
        (error) => {

          console.error(
            `[BUILD ${id}] QUEUED BUILD FAILED`
          );

          console.error(
            error.stack || error
          );
        }
      );

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res
      .status(202)
      .json({

        success:
          true,

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

    if (
      !job
    ) {

      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "Build job not found"
        });
    }

    res.json({
      success:
        true,

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

    if (
      !job
    ) {

      return res
        .status(404)
        .json({
          success:
            false,

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
          success:
            false,

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
            success:
              false,

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
          success:
            false,

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
      " Gabinarou WebView APK Builder v3.2"
    );

    console.log(
      "========================================"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `HOST: ${HOST}`
    );

    console.log(
      "API: /api/build"
    );

    console.log(
      "Health: /health"
    );

    console.log(
      "Gradle logs: ENABLED"
    );

    console.log(
      "Gradle workers: 1"
    );

    console.log(
      "Gradle JVM heap: 256MB"
    );

    console.log(
      `Gradle timeout: ${GRADLE_TIMEOUT}ms`
    );

    console.log(
      "Build queue: SINGLE BUILD"
    );

    console.log(
      "Isolated workspace: ENABLED"
    );

    console.log(
      "========================================"
    );

    console.log(
      "Service is ready."
    );

    console.log(
      `Memory: ${memoryInfo()}`
    );

    console.log(
      "========================================"
    );
  }
);
