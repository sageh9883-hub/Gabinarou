const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const os = require("os");

const app = express();

const VERSION = "3.6.0";
const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = "/builder";
const TEMPLATE_DIR = path.join(ROOT, "template");
const JOBS_DIR = path.join(ROOT, "jobs");
const BUILDS_DIR = path.join(ROOT, "builds");
const WORKSPACES_DIR = path.join(ROOT, "workspaces");

const GRADLE_BIN =
  process.env.GRADLE_BIN ||
  "/opt/gradle/gradle-9.7.1/bin/gradle";

const GRADLE_VERSION = "9.7.1";

const BUILD_TIMEOUT =
  Number(process.env.BUILD_TIMEOUT_MS || 600000);

const MAX_QUEUE =
  Number(process.env.MAX_QUEUE || 3);

/*
 * IMPORTANT:
 * Render Free = 512 MB.
 *
 * We intentionally keep the JVM small.
 */
const JAVA_TOOL_OPTIONS =
  "-Xms32m " +
  "-Xmx160m " +
  "-XX:MaxMetaspaceSize=64m " +
  "-XX:ReservedCodeCacheSize=32m " +
  "-XX:+UseSerialGC " +
  "-XX:ActiveProcessorCount=1";

const GRADLE_JVM_ARGS =
  "-Xms32m " +
  "-Xmx160m " +
  "-XX:MaxMetaspaceSize=64m " +
  "-XX:ReservedCodeCacheSize=32m " +
  "-XX:+UseSerialGC " +
  "-XX:ActiveProcessorCount=1";

const GRADLE_OPTS =
  "-Dorg.gradle.daemon=false " +
  `-Dorg.gradle.jvmargs="${GRADLE_JVM_ARGS}" ` +
  "-Dorg.gradle.parallel=false " +
  "-Dorg.gradle.workers.max=1 " +
  "-Dorg.gradle.caching=false " +
  "-Dorg.gradle.configuration-cache=false " +
  "-Dorg.gradle.vfs.watch=false " +
  "-Dkotlin.compiler.execution.strategy=in-process " +
  "-Dkotlin.daemon.enabled=false " +
  "-Dfile.encoding=UTF-8";

const NODE_OPTIONS_VALUE =
  "--max-old-space-size=96";

const jobs = new Map();

let activeJob = null;
let queuedBuilds = [];


// ============================================================
// EXPRESS
// ============================================================

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors());

app.use(express.json({
  limit: "256kb"
}));


// ============================================================
// REQUEST LOGGER
// ============================================================

app.use((req, res, next) => {
  const started = Date.now();

  const requestId =
    req.headers["rndr-id"] ||
    crypto.randomUUID();

  res.setHeader("X-Request-ID", requestId);

  res.on("finish", () => {
    const duration = Date.now() - started;

    console.log(
      `[HTTP] ${req.method} ${req.originalUrl} ` +
      `${res.statusCode} ${duration}ms ` +
      `requestId=${requestId}`
    );
  });

  next();
});


// ============================================================
// HELPERS
// ============================================================

function now() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomBytes(12).toString("hex");
}

function safeName(value, fallback = "app") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function validatePackageName(value) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/
    .test(value);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function memoryMB() {
  const m = process.memoryUsage();

  return {
    rss: Math.round(m.rss / 1024 / 1024),
    heapUsed: Math.round(m.heapUsed / 1024 / 1024),
    heapTotal: Math.round(m.heapTotal / 1024 / 1024),
    external: Math.round(m.external / 1024 / 1024),
    arrayBuffers: Math.round(m.arrayBuffers / 1024 / 1024)
  };
}

function readCgroupMemory() {
  try {
    const currentPath =
      "/sys/fs/cgroup/memory.current";

    const maxPath =
      "/sys/fs/cgroup/memory.max";

    const eventsPath =
      "/sys/fs/cgroup/memory.events";

    let currentMB = null;
    let max = null;
    let events = {};

    if (fs.existsSync(currentPath)) {
      const current =
        Number(fs.readFileSync(currentPath, "utf8").trim());

      if (Number.isFinite(current)) {
        currentMB =
          Math.round(current / 1024 / 1024);
      }
    }

    if (fs.existsSync(maxPath)) {
      max =
        fs.readFileSync(maxPath, "utf8").trim();

      if (max !== "max") {
        const n = Number(max);

        if (Number.isFinite(n)) {
          max =
            Math.round(n / 1024 / 1024) + "MB";
        }
      }
    }

    if (fs.existsSync(eventsPath)) {
      const lines =
        fs.readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n");

      for (const line of lines) {
        const [key, value] = line.split(/\s+/);

        if (key) {
          events[key] = Number(value);
        }
      }
    }

    return {
      memoryCurrentMB: currentMB,
      memoryMax: max,
      memoryEvents: events
    };

  } catch (error) {
    return {
      error: error.message
    };
  }
}

function diskInfo() {
  try {
    const stat = fs.statfsSync("/");

    const total =
      Number(stat.blocks) *
      Number(stat.bsize);

    const free =
      Number(stat.bfree) *
      Number(stat.bsize);

    const available =
      Number(stat.bavail) *
      Number(stat.bsize);

    const used = total - free;

    return {
      totalMB: Math.round(total / 1024 / 1024),
      usedMB: Math.round(used / 1024 / 1024),
      freeMB: Math.round(free / 1024 / 1024),
      availableMB: Math.round(
        available / 1024 / 1024
      )
    };

  } catch (error) {
    return {
      error: error.message
    };
  }
}

function systemDiagnostics() {
  return {
    node: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: memoryMB(),
    cpu: os.loadavg(),
    disk: diskInfo(),
    cgroup: readCgroupMemory()
  };
}

function jobDir(jobId) {
  return path.join(JOBS_DIR, jobId);
}

function jobFile(jobId) {
  return path.join(
    jobDir(jobId),
    "job.json"
  );
}

function logFile(jobId) {
  return path.join(
    jobDir(jobId),
    "build.log"
  );
}

async function ensureDirectories() {
  await fsp.mkdir(JOBS_DIR, {
    recursive: true
  });

  await fsp.mkdir(BUILDS_DIR, {
    recursive: true
  });

  await fsp.mkdir(WORKSPACES_DIR, {
    recursive: true
  });
}

async function saveJob(job) {
  try {
    await fsp.mkdir(
      jobDir(job.id),
      { recursive: true }
    );

    await fsp.writeFile(
      jobFile(job.id),
      JSON.stringify(job, null, 2),
      "utf8"
    );

  } catch (error) {
    console.error(
      `[JOB ${job.id}] saveJob error:`,
      error.message
    );
  }
}

function appendJobLog(job, message) {
  const line =
    `[${now()}] ${message}`;

  console.log(line);

  if (job) {
    const file = logFile(job.id);

    fs.mkdir(
      path.dirname(file),
      { recursive: true },
      (mkdirError) => {
        if (mkdirError) return;

        fs.appendFile(
          file,
          line + "\n",
          "utf8",
          () => {}
        );
      }
    );
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch, {
    updatedAt: now()
  });

  jobs.set(job.id, job);

  saveJob(job).catch(() => {});
}

function getPublicBaseUrl(req) {
  return (
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`
  );
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}


// ============================================================
// MEMORY GUARD
// ============================================================

function startMemoryGuard(job, child) {
  let stopped = false;
  let interval = null;
  let highCount = 0;
  let warned = false;

  interval = setInterval(() => {
    if (stopped) return;

    const cg = readCgroupMemory();
    const current = cg.memoryCurrentMB;

    if (!Number.isFinite(current)) {
      return;
    }

    appendJobLog(
      job,
      `MEMORY current=${current}MB ` +
      `max=${cg.memoryMax} ` +
      `events=${JSON.stringify(cg.memoryEvents)}`
    );

    /*
     * Warning zone.
     */
    if (current >= 450 && !warned) {
      warned = true;

      appendJobLog(
        job,
        `WARNING: memory pressure detected at ${current}MB.`
      );
    }

    /*
     * Emergency zone.
     *
     * We deliberately stop before Render's 512MB
     * hard limit.
     */
    if (current >= 485) {
      highCount++;

      appendJobLog(
        job,
        `HIGH MEMORY ${current}MB ` +
        `(${highCount}/2)`
      );

      if (highCount >= 2) {
        appendJobLog(
          job,
          `MEMORY GUARD: stopping Gradle before cgroup limit.`
        );

        killProcessTree(child);

        updateJob(job, {
          status: "failed",
          error:
            `Build stopped because container memory ` +
            `reached ${current}MB of ${cg.memoryMax}.`
        });

        stop();

        return;
      }

    } else {
      highCount = 0;
    }

  }, 2000);

  function stop() {
    stopped = true;

    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  return stop;
}


// ============================================================
// PROCESS MANAGEMENT
// ============================================================

function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }

  const pid = child.pid;

  try {
    /*
     * detached=true means the child is the process-group
     * leader. Negative PID kills the complete group.
     */
    process.kill(-pid, "SIGTERM");

    console.error(
      `[PROCESS] SIGTERM process group ${pid}`
    );

  } catch (error) {
    try {
      child.kill("SIGTERM");

      console.error(
        `[PROCESS] SIGTERM child ${pid}:`,
        error.message
      );

    } catch (error2) {
      console.error(
        `[PROCESS] Unable to terminate ${pid}:`,
        error2.message
      );
    }
  }

  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");

      console.error(
        `[PROCESS] SIGKILL process group ${pid}`
      );

    } catch {
      try {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      } catch {}
    }
  }, 3000);
}


function runProcess(
  job,
  command,
  args,
  options = {}
) {
  return new Promise((resolve, reject) => {

    appendJobLog(
      job,
      `PROCESS START: ${command} ${args.join(" ")}`
    );

    const env = {
      ...process.env,

      NODE_OPTIONS: NODE_OPTIONS_VALUE,

      JAVA_TOOL_OPTIONS:
        JAVA_TOOL_OPTIONS,

      GRADLE_OPTS:
        GRADLE_OPTS,

      GRADLE_USER_HOME:
        "/builder/.gradle",

      /*
       * Prevent Gradle from thinking many CPUs exist.
       */
      JAVA_HOME:
        process.env.JAVA_HOME ||
        "/usr/lib/jvm/java-17-openjdk-amd64"
    };

    const child = spawn(
      command,
      args,
      {
        cwd: options.cwd,
        env,
        shell: false,
        detached: true,
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

    let finished = false;
    let timedOut = false;

    let memoryGuardStop = null;

    const timeout = setTimeout(() => {
      if (finished) return;

      timedOut = true;

      appendJobLog(
        job,
        `PROCESS TIMEOUT after ${BUILD_TIMEOUT}ms`
      );

      killProcessTree(child);

    }, BUILD_TIMEOUT);

    memoryGuardStop =
      startMemoryGuard(job, child);

    appendJobLog(
      job,
      `PROCESS CREATED pid=${child.pid}`
    );

    child.stdout.on(
      "data",
      data => {
        const text =
          data.toString();

        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            appendJobLog(
              job,
              `[PROCESS] ${line}`
            );
          }
        }
      }
    );

    child.stderr.on(
      "data",
      data => {
        const text =
          data.toString();

        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            appendJobLog(
              job,
              `[PROCESS-ERR] ${line}`
            );
          }
        }
      }
    );

    child.on(
      "error",
      error => {
        appendJobLog(
          job,
          `PROCESS ERROR: ${error.stack || error}`
        );
      }
    );

    child.on(
      "exit",
      (code, signal) => {
        appendJobLog(
          job,
          `PROCESS EXIT code=${code} signal=${signal}`
        );
      }
    );

    child.on(
      "close",
      (code, signal) => {
        if (finished) return;

        finished = true;

        clearTimeout(timeout);

        if (memoryGuardStop) {
          memoryGuardStop();
        }

        appendJobLog(
          job,
          `PROCESS CLOSE code=${code} signal=${signal}`
        );

        if (timedOut) {
          reject(
            new Error(
              `Process timeout after ${BUILD_TIMEOUT}ms`
            )
          );

          return;
        }

        if (code !== 0) {
          reject(
            new Error(
              `Process exited with code ${code}` +
              (signal
                ? ` signal ${signal}`
                : "")
            )
          );

          return;
        }

        resolve({
          code,
          signal
        });
      }
    );
  });
}


// ============================================================
// TEMPLATE
// ============================================================

async function copyTemplate(destination) {
  appendJobLog(
    null,
    `Copying template to ${destination}`
  );

  await fsp.cp(
    TEMPLATE_DIR,
    destination,
    {
      recursive: true,
      filter(source) {
        const normalized =
          source.replace(/\\/g, "/");

        if (
          normalized.includes("/.gradle/")
        ) {
          return false;
        }

        if (
          normalized.includes("/build/")
        ) {
          return false;
        }

        if (
          normalized.endsWith("/build")
        ) {
          return false;
        }

        return true;
      }
    }
  );
}

async function writeGradleProperties(workspace) {
  const gradleDir =
    path.join(workspace, ".gradle");

  /*
   * Project-local Gradle properties.
   *
   * These make the daemon/workers settings explicit
   * instead of relying only on environment variables.
   */
  const properties = [
    "org.gradle.daemon=false",
    "org.gradle.parallel=false",
    "org.gradle.workers.max=1",
    "org.gradle.caching=false",
    "org.gradle.configuration-cache=false",
    "org.gradle.vfs.watch=false",
    "org.gradle.jvmargs=" +
      GRADLE_JVM_ARGS,
    "kotlin.compiler.execution.strategy=in-process",
    "kotlin.daemon.enabled=false",
    "android.builder.sdkDownload=false"
  ].join("\n") + "\n";

  await fsp.mkdir(
    gradleDir,
    { recursive: true }
  );

  await fsp.writeFile(
    path.join(
      workspace,
      "gradle.properties"
    ),
    properties,
    "utf8"
  );
}

async function writeAppProperties(
  workspace,
  job
) {
  const properties = [
    `app.url=${job.url}`,
    `app.package=${job.packageName}`,
    `app.name=${job.name}`,
    job.iconUrl
      ? `app.icon_url=${job.iconUrl}`
      : "",
    `app.version=${job.version || "1.0.0"}`
  ]
    .filter(Boolean)
    .join("\n") + "\n";

  await fsp.writeFile(
    path.join(
      workspace,
      "app.properties"
    ),
    properties,
    "utf8"
  );
}


// ============================================================
// BUILD
// ============================================================

async function processBuild(job) {

  activeJob = job.id;

  const workspace =
    path.join(
      WORKSPACES_DIR,
      job.id
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

  const finalApk =
    path.join(
      BUILDS_DIR,
      `${safeName(job.name)}-${job.id}.apk`
    );

  const finalZip =
    path.join(
      BUILDS_DIR,
      `${safeName(job.name)}-${job.id}.zip`
    );

  try {

    appendJobLog(
      job,
      "=================================================="
    );

    appendJobLog(
      job,
      `BUILD ${VERSION} START`
    );

    appendJobLog(
      job,
      `Job: ${job.id}`
    );

    appendJobLog(
      job,
      `URL: ${job.url}`
    );

    appendJobLog(
      job,
      `Package: ${job.packageName}`
    );

    appendJobLog(
      job,
      `Name: ${job.name}`
    );

    appendJobLog(
      job,
      `Gradle: ${GRADLE_BIN}`
    );

    appendJobLog(
      job,
      `Java options: ${JAVA_TOOL_OPTIONS}`
    );

    appendJobLog(
      job,
      `Gradle options: ${GRADLE_OPTS}`
    );

    appendJobLog(
      job,
      `Initial diagnostics: ${JSON.stringify(
        systemDiagnostics()
      )}`
    );


    // --------------------------------------------------------
    // STEP 1
    // --------------------------------------------------------

    updateJob(job, {
      status: "building",
      step: "Preparing workspace"
    });

    appendJobLog(
      job,
      "STEP 1/10: Preparing isolated workspace."
    );

    await fsp.rm(
      workspace,
      {
        recursive: true,
        force: true
      }
    );

    await fsp.mkdir(
      workspace,
      {
        recursive: true
      }
    );


    // --------------------------------------------------------
    // STEP 2
    // --------------------------------------------------------

    appendJobLog(
      job,
      "STEP 2/10: Copying WebView template."
    );

    await copyTemplate(workspace);


    // --------------------------------------------------------
    // STEP 3
    // --------------------------------------------------------

    appendJobLog(
      job,
      "STEP 3/10: Writing app.properties."
    );

    await writeAppProperties(
      workspace,
      job
    );

    await writeGradleProperties(
      workspace
    );


    // --------------------------------------------------------
    // STEP 4
    // --------------------------------------------------------

    appendJobLog(
      job,
      "STEP 4/10: Checking Gradle."
    );

    if (
      !fs.existsSync(GRADLE_BIN)
    ) {
      throw new Error(
        `Gradle not found: ${GRADLE_BIN}`
      );
    }

    appendJobLog(
      job,
      `Gradle exists: ${GRADLE_BIN}`
    );


    // --------------------------------------------------------
    // STEP 5
    // --------------------------------------------------------

    appendJobLog(
      job,
      "STEP 5/10: Checking Gradle wrapper files."
    );

    const gradlew =
      path.join(
        workspace,
        "gradlew"
      );

    if (!fs.existsSync(gradlew)) {
      throw new Error(
        "gradlew not found in template."
      );
    }

    try {
      await fsp.chmod(
        gradlew,
        0o755
      );
    } catch {}

    appendJobLog(
      job,
      "gradlew is ready."
    );


    // --------------------------------------------------------
    // STEP 6
    // --------------------------------------------------------

    updateJob(job, {
      step: "Launching Gradle"
    });

    appendJobLog(
      job,
      "STEP 6/10: Launching Gradle."
    );

    appendJobLog(
      job,
      `Memory before Gradle: ${JSON.stringify(
        systemDiagnostics()
      )}`
    );


    // --------------------------------------------------------
    // STEP 7
    // --------------------------------------------------------

    appendJobLog(
      job,
      "STEP 7/10: Running Android build."
    );

    const gradleArgs = [
      "assembleDebug",

      "--no-daemon",

      "--console=plain",

      "--stacktrace",

      "--max-workers=1",

      "--no-parallel"
    ];

    appendJobLog(
      job,
      `Command: ${GRADLE_BIN} ${gradleArgs.join(" ")}`
    );

    await runProcess(
      job,
      GRADLE_BIN,
      gradleArgs,
      {
        cwd: workspace
      }
    );


    // --------------------------------------------------------
    // STEP 8
    // --------------------------------------------------------

    appendJobLog(
      job,
      "STEP 8/10: Checking generated APK."
    );

    appendJobLog(
      job,
      `Memory after Gradle: ${JSON.stringify(
        systemDiagnostics()
      )}`
    );

    if (!fs.existsSync(apkSource)) {
      throw new Error(
        `APK not found: ${apkSource}`
      );
    }

    const apkStat =
      await fsp.stat(apkSource);

    if (apkStat.size <= 0) {
      throw new Error(
        "Generated APK is empty."
      );
    }

    appendJobLog(
      job,
      `APK generated: ${apkStat.size} bytes`
    );


    // --------------------------------------------------------
    // STEP 9
    // --------------------------------------------------------

    updateJob(job, {
      step: "Copying APK"
    });

    appendJobLog(
      job,
      "STEP 9/10: Copying final APK."
    );

    await fsp.copyFile(
      apkSource,
      finalApk
    );

    const finalApkStat =
      await fsp.stat(finalApk);

    appendJobLog(
      job,
      `Final APK: ${finalApk}`
    );

    appendJobLog(
      job,
      `Final APK size: ${finalApkStat.size} bytes`
    );


    // --------------------------------------------------------
    // STEP 10
    // --------------------------------------------------------

    updateJob(job, {
      step: "Creating ZIP"
    });

    appendJobLog(
      job,
      "STEP 10/10: Creating ZIP."
    );

    /*
     * ZIP only contains the final APK.
     *
     * This keeps the result small and avoids copying
     * the entire Android project.
     */
    await runProcess(
      job,
      "zip",
      [
        "-j",
        finalZip,
        finalApk
      ],
      {
        cwd: BUILDS_DIR
      }
    );

    if (!fs.existsSync(finalZip)) {
      throw new Error(
        "ZIP was not created."
      );
    }

    const zipStat =
      await fsp.stat(finalZip);

    appendJobLog(
      job,
      `ZIP created: ${zipStat.size} bytes`
    );


    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      null;

    updateJob(job, {
      status: "completed",
      step: "Completed",
      apkPath: finalApk,
      zipPath: finalZip,
      apkSize: finalApkStat.size,
      zipSize: zipStat.size,
      downloadUrl: baseUrl
        ? `${baseUrl}/api/download/${job.id}/apk`
        : `/api/download/${job.id}/apk`,
      zipDownloadUrl: baseUrl
        ? `${baseUrl}/api/download/${job.id}/zip`
        : `/api/download/${job.id}/zip`
    });

    appendJobLog(
      job,
      "=================================================="
    );

    appendJobLog(
      job,
      "BUILD COMPLETED SUCCESSFULLY."
    );

    appendJobLog(
      job,
      `APK URL: ${
        baseUrl
          ? `${baseUrl}/api/download/${job.id}/apk`
          : `/api/download/${job.id}/apk`
      }`
    );

    appendJobLog(
      job,
      `ZIP URL: ${
        baseUrl
          ? `${baseUrl}/api/download/${job.id}/zip`
          : `/api/download/${job.id}/zip`
      }`
    );

  } catch (error) {

    console.error(
      `[BUILD ${job.id}] FAILED`,
      error
    );

    updateJob(job, {
      status: "failed",
      step: "Failed",
      error:
        error.stack ||
        error.message ||
        String(error)
    });

    appendJobLog(
      job,
      `BUILD FAILED: ${
        error.stack ||
        error.message ||
        error
      }`
    );

  } finally {

    try {
      await fsp.rm(
        workspace,
        {
          recursive: true,
          force: true
        }
      );

      appendJobLog(
        job,
        "Workspace cleaned."
      );

    } catch (cleanupError) {

      appendJobLog(
        job,
        `Workspace cleanup failed: ${
          cleanupError.message
        }`
      );
    }

    activeJob = null;

    appendJobLog(
      job,
      `Final diagnostics: ${JSON.stringify(
        systemDiagnostics()
      )}`
    );
  }
}


// ============================================================
// BUILD QUEUE
// ============================================================

function enqueueBuild(job) {

  if (
    queuedBuilds.length >= MAX_QUEUE
  ) {
    return false;
  }

  queuedBuilds.push(job.id);

  updateJob(job, {
    status: "queued",
    queuePosition:
      queuedBuilds.length
  });

  processQueue();

  return true;
}

async function processQueue() {

  if (activeJob) {
    return;
  }

  const id =
    queuedBuilds.shift();

  if (!id) {
    return;
  }

  const job =
    jobs.get(id);

  if (!job) {
    processQueue();
    return;
  }

  updateJob(job, {
    status: "starting",
    queuePosition: null
  });

  try {

    await processBuild(job);

  } catch (error) {

    console.error(
      `[QUEUE ${id}] unexpected error:`,
      error
    );

    updateJob(job, {
      status: "failed",
      error:
        error.stack ||
        error.message ||
        String(error)
    });

  } finally {

    activeJob = null;

    setImmediate(
      processQueue
    );
  }
}


// ============================================================
// ROUTES
// ============================================================

app.get("/", (req, res) => {

  res.json({
    success: true,
    service:
      "gabinarou-webview-apk-builder",
    version: VERSION,
    status: "online",
    endpoints: {
      health: "/health",
      debug: "/api/debug",
      build: "POST /api/build",
      status: "GET /api/build/:id",
      logs: "GET /api/build/:id/logs",
      apk:
        "GET /api/download/:id/apk",
      zip:
        "GET /api/download/:id/zip"
    }
  });
});


app.get("/health", (req, res) => {

  const gradleExists =
    fs.existsSync(GRADLE_BIN);

  const sdkRoot =
    process.env.ANDROID_SDK_ROOT ||
    "/opt/android-sdk";

  const platform37 =
    fs.existsSync(
      path.join(
        sdkRoot,
        "platforms",
        "android-37"
      )
    );

  const buildTools37 =
    fs.existsSync(
      path.join(
        sdkRoot,
        "build-tools",
        "37.0.0"
      )
    );

  res.json({
    success: true,

    service:
      "gabinarou-webview-apk-builder",

    version: VERSION,

    status: "online",

    uptimeSeconds:
      Math.round(process.uptime()),

    activeJob,

    queuedJobs:
      queuedBuilds.length,

    gradle: {
      installed: gradleExists,
      version: GRADLE_VERSION,
      path: GRADLE_BIN
    },

    android: {
      sdkRoot,
      platform37,
      buildTools37: buildTools37
        ? ["37.0.0"]
        : []
    },

    memory:
      memoryMB(),

    disk:
      diskInfo(),

    cgroup:
      readCgroupMemory(),

    limits: {
      node:
        NODE_OPTIONS_VALUE,

      java:
        JAVA_TOOL_OPTIONS,

      gradle:
        GRADLE_JVM_ARGS,

      workers: 1,

      timeoutMs:
        BUILD_TIMEOUT,

      maxQueue:
        MAX_QUEUE
    }
  });
});


app.get("/api/debug", (req, res) => {

  res.json({
    success: true,

    version: VERSION,

    pid: process.pid,

    activeJob,

    queue: queuedBuilds,

    diagnostics:
      systemDiagnostics(),

    environment: {
      port: PORT,
      host: HOST,
      node:
        process.version,

      gradleBin:
        GRADLE_BIN,

      gradleHome:
        process.env.GRADLE_HOME ||
        null,

      androidSdk:
        process.env.ANDROID_SDK_ROOT ||
        null
    },

    paths: {
      root: ROOT,
      template: TEMPLATE_DIR,
      jobs: JOBS_DIR,
      builds: BUILDS_DIR,
      workspaces: WORKSPACES_DIR
    }
  });
});


// ============================================================
// POST /api/build
// ============================================================

app.post("/api/build", async (req, res) => {

  try {

    const {
      url,
      name,
      packageName,
      version,
      iconUrl
    } = req.body || {};

    // --------------------------------------------------------
    // Validation
    // --------------------------------------------------------

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "url is required"
      });
    }

    if (!isHttpsUrl(url)) {
      return res.status(400).json({
        success: false,
        error:
          "url must be a valid HTTPS URL"
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "name is required"
      });
    }

    if (!packageName) {
      return res.status(400).json({
        success: false,
        error:
          "packageName is required"
      });
    }

    if (!validatePackageName(packageName)) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid Android packageName"
      });
    }

    if (iconUrl && !isHttpsUrl(iconUrl)) {
      return res.status(400).json({
        success: false,
        error:
          "iconUrl must be a valid HTTPS URL"
      });
    }

    // --------------------------------------------------------
    // Queue limit
    // --------------------------------------------------------

    if (
      queuedBuilds.length >= MAX_QUEUE &&
      activeJob
    ) {
      return res.status(429).json({
        success: false,
        error:
          "Build queue is full",
        activeJob,
        queuedJobs:
          queuedBuilds.length
      });
    }

    // --------------------------------------------------------
    // Job
    // --------------------------------------------------------

    const id = createId();

    const job = {
      id,

      status: "created",

      step: "Creating job",

      createdAt: now(),

      updatedAt: now(),

      url,

      name:
        String(name)
          .trim()
          .slice(0, 80),

      packageName,

      version:
        version ||
        "1.0.0",

      iconUrl:
        iconUrl || null,

      requestId:
        req.headers["rndr-id"] ||
        crypto.randomUUID(),

      statusUrl:
        `/api/build/${id}`,

      logsUrl:
        `/api/build/${id}/logs`
    };

    jobs.set(
      id,
      job
    );

    await saveJob(job);

    appendJobLog(
      job,
      `NEW BUILD JOB: ${id}`
    );

    appendJobLog(
      job,
      `Request: ${JSON.stringify({
        url,
        name,
        packageName,
        version,
        iconUrl
      })}`
    );

    // --------------------------------------------------------
    // Queue
    // --------------------------------------------------------

    const accepted =
      enqueueBuild(job);

    if (!accepted) {

      updateJob(job, {
        status: "rejected",
        error:
          "Build queue is full"
      });

      return res.status(429).json({
        success: false,
        error:
          "Build queue is full"
      });
    }

    const baseUrl =
      getPublicBaseUrl(req);

    return res.status(202).json({
      success: true,

      jobId: id,

      status: job.status,

      statusUrl:
        `${baseUrl}/api/build/${id}`,

      logsUrl:
        `${baseUrl}/api/build/${id}/logs`
    });

  } catch (error) {

    console.error(
      "[POST /api/build]",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error.message ||
        String(error)
    });
  }
});


// ============================================================
// GET JOB
// ============================================================

app.get(
  "/api/build/:id",
  async (req, res) => {

    const job =
      jobs.get(req.params.id);

    if (!job) {

      /*
       * Try persistent file if Node restarted.
       */
      try {

        const raw =
          await fsp.readFile(
            jobFile(req.params.id),
            "utf8"
          );

        const saved =
          JSON.parse(raw);

        jobs.set(
          saved.id,
          saved
        );

        return res.json({
          success: true,
          job: saved
        });

      } catch {

        return res.status(404).json({
          success: false,
          error:
            "Build job not found"
        });
      }
    }

    return res.json({
      success: true,
      job
    });
  }
);


// ============================================================
// GET LOGS
// ============================================================

app.get(
  "/api/build/:id/logs",
  async (req, res) => {

    const file =
      logFile(req.params.id);

    try {

      const content =
        await fsp.readFile(
          file,
          "utf8"
        );

      res.type("text/plain");
      return res.send(content);

    } catch {

      return res.status(404).json({
        success: false,
        error:
          "Build logs not found"
      });
    }
  }
);


// ============================================================
// DOWNLOAD APK
// ============================================================

app.get(
  "/api/download/:id/apk",
  async (req, res) => {

    const job =
      jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error:
          "Build job not found"
      });
    }

    if (
      job.status !== "completed"
    ) {
      return res.status(409).json({
        success: false,
        error:
          "Build is not completed",
        status:
          job.status
      });
    }

    if (
      !job.apkPath ||
      !fs.existsSync(job.apkPath)
    ) {
      return res.status(404).json({
        success: false,
        error:
          "APK file not found"
      });
    }

    return res.download(
      job.apkPath,
      `${safeName(job.name)}.apk`
    );
  }
);


// ============================================================
// DOWNLOAD ZIP
// ============================================================

app.get(
  "/api/download/:id/zip",
  async (req, res) => {

    const job =
      jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error:
          "Build job not found"
      });
    }

    if (
      job.status !== "completed"
    ) {
      return res.status(409).json({
        success: false,
        error:
          "Build is not completed",
        status:
          job.status
      });
    }

    if (
      !job.zipPath ||
      !fs.existsSync(job.zipPath)
    ) {
      return res.status(404).json({
        success: false,
        error:
          "ZIP file not found"
      });
    }

    return res.download(
      job.zipPath,
      `${safeName(job.name)}.zip`
    );
  }
);


// ============================================================
// PROCESS DIAGNOSTICS
// ============================================================

process.on(
  "SIGTERM",
  () => {

    console.error(
      "[PROCESS] SIGTERM received."
    );

    if (activeJob) {
      console.error(
        `[PROCESS] Active job: ${activeJob}`
      );
    }

    /*
     * Let Render terminate the process normally.
     */
    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {

    console.error(
      "[PROCESS] SIGINT received."
    );

    process.exit(0);
  }
);

process.on(
  "uncaughtException",
  error => {

    console.error(
      "[PROCESS] UNCAUGHT EXCEPTION:",
      error.stack || error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "[PROCESS] UNHANDLED REJECTION:",
      error
    );
  }
);

process.on(
  "exit",
  code => {

    console.error(
      `[PROCESS] EXIT code=${code}`
    );
  }
);


// ============================================================
// STARTUP
// ============================================================

async function startup() {

  await ensureDirectories();

  console.log(
    "=================================================="
  );

  console.log(
    `Gabinarou WebView APK Builder v${VERSION}`
  );

  console.log(
    `PORT: ${PORT}`
  );

  console.log(
    `Host: ${HOST}`
  );

  console.log(
    "API: /api/build"
  );

  console.log(
    "Health: /health"
  );

  console.log(
    "Debug: /api/debug"
  );

  console.log(
    "Logs: /api/build/:id/logs"
  );

  console.log(
    "Gradle: PREINSTALLED"
  );

  console.log(
    `Gradle version: ${GRADLE_VERSION}`
  );

  console.log(
    `Gradle path: ${GRADLE_BIN}`
  );

  console.log(
    `Gradle workers: 1`
  );

  console.log(
    `Java heap: 160MB`
  );

  console.log(
    `Java metaspace: 64MB`
  );

  console.log(
    `Node heap: ${NODE_OPTIONS_VALUE}`
  );

  console.log(
    `Build timeout: ${BUILD_TIMEOUT}ms`
  );

  console.log(
    `Max queue: ${MAX_QUEUE}`
  );

  console.log(
    `Node: ${process.version}`
  );

  console.log(
    `PID: ${process.pid}`
  );

  console.log(
    `Template exists: ${fs.existsSync(
      TEMPLATE_DIR
    )}`
  );

  console.log(
    `Gradle exists: ${fs.existsSync(
      GRADLE_BIN
    )}`
  );

  console.log(
    `Android SDK: ${
      process.env.ANDROID_SDK_ROOT ||
      "/opt/android-sdk"
    }`
  );

  console.log(
    `Initial diagnostics: ${JSON.stringify(
      systemDiagnostics()
    )}`
  );

  console.log(
    "=================================================="
  );

  app.listen(
    PORT,
    HOST,
    () => {

      console.log(
        "Your service is live"
      );

      if (process.env.RENDER_EXTERNAL_URL) {
        console.log(
          process.env.RENDER_EXTERNAL_URL
        );
      } else {
        console.log(
          `http://${HOST}:${PORT}`
        );
      }
    }
  );
}

startup().catch(error => {

  console.error(
    "STARTUP FAILED:",
    error.stack || error
  );

  process.exit(1);
});
