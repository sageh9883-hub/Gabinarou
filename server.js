"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const VERSION = "3.5.0";

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
  Number(process.env.BUILD_TIMEOUT_MS) || 10 * 60 * 1000;

const MAX_QUEUE =
  Number(process.env.MAX_QUEUE) || 3;

const JAVA_TOOL_OPTIONS =
  process.env.JAVA_TOOL_OPTIONS ||
  "-Xmx256m -XX:MaxMetaspaceSize=128m";

const GRADLE_OPTS =
  process.env.GRADLE_OPTS ||
  "-Dorg.gradle.jvmargs=-Xmx256m -Dorg.gradle.daemon=false";

const app = express();

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(cors());

app.use(express.json({
  limit: "2mb"
}));

/* =========================================================
   STATE
========================================================= */

const jobs = new Map();

let activeJobId = null;
let queue = [];

const startedAt = Date.now();

/* =========================================================
   UTILITIES
========================================================= */

function now() {
  return new Date().toISOString();
}

function memoryMB() {
  const m = process.memoryUsage();

  return {
    rss: Math.round(m.rss / 1024 / 1024),
    heapUsed: Math.round(m.heapUsed / 1024 / 1024),
    heapTotal: Math.round(m.heapTotal / 1024 / 1024),
    external: Math.round(m.external / 1024 / 1024),
    arrayBuffers: Math.round((m.arrayBuffers || 0) / 1024 / 1024)
  };
}

function cpuInfo() {
  const usage = process.resourceUsage();

  return {
    loadAverage: os.loadavg(),
    userCPUms: Math.round(usage.userCPUTime / 1000),
    systemCPUms: Math.round(usage.systemCPUTime / 1000),
    maxRSSMB: Math.round(usage.maxRSS / 1024)
  };
}

function diskInfo(target = "/") {
  try {
    const stat = fs.statfsSync(target);

    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bfree) * Number(stat.bsize);
    const available = Number(stat.bavail) * Number(stat.bsize);
    const used = total - free;

    return {
      path: target,
      totalMB: Math.round(total / 1024 / 1024),
      usedMB: Math.round(used / 1024 / 1024),
      freeMB: Math.round(free / 1024 / 1024),
      availableMB: Math.round(available / 1024 / 1024)
    };
  } catch (err) {
    return {
      path: target,
      error: err.message
    };
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function cgroupInfo() {
  const result = {};

  const memoryCurrent =
    readFileSafe("/sys/fs/cgroup/memory.current");

  const memoryMax =
    readFileSafe("/sys/fs/cgroup/memory.max");

  const memoryEvents =
    readFileSafe("/sys/fs/cgroup/memory.events");

  if (memoryCurrent) {
    const n = Number(memoryCurrent.trim());

    if (Number.isFinite(n)) {
      result.memoryCurrentMB =
        Math.round(n / 1024 / 1024);
    }
  }

  if (memoryMax) {
    const value = memoryMax.trim();

    result.memoryMax =
      value === "max"
        ? "max"
        : `${Math.round(Number(value) / 1024 / 1024)}MB`;
  }

  if (memoryEvents) {
    result.memoryEvents = {};

    for (const line of memoryEvents.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);

      if (parts.length === 2) {
        result.memoryEvents[parts[0]] =
          Number(parts[1]);
      }
    }
  }

  return result;
}

function systemDiagnostics() {
  return {
    timestamp: now(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),

    memory: memoryMB(),
    cpu: cpuInfo(),

    disk: {
      root: diskInfo("/"),
      builder: diskInfo(ROOT)
    },

    cgroup: cgroupInfo()
  };
}

function logSystem(prefix = "[SYSTEM]") {
  const d = systemDiagnostics();

  console.log(
    `${prefix} uptime=${d.uptimeSeconds}s ` +
    `rss=${d.memory.rss}MB ` +
    `heap=${d.memory.heapUsed}/${d.memory.heapTotal}MB ` +
    `cpu=${JSON.stringify(d.cpu.loadAverage)} ` +
    `diskFree=${d.disk.root.freeMB}MB ` +
    `cgroup=${JSON.stringify(d.cgroup)}`
  );
}

function jobPath(id) {
  return path.join(JOBS_DIR, id);
}

function jobJsonPath(id) {
  return path.join(jobPath(id), "job.json");
}

function jobLogPath(id) {
  return path.join(jobPath(id), "build.log");
}

async function ensureDirs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(BUILDS_DIR, { recursive: true });
  await fsp.mkdir(WORKSPACES_DIR, { recursive: true });
}

async function saveJob(job) {
  jobs.set(job.id, job);

  await fsp.mkdir(jobPath(job.id), {
    recursive: true
  });

  await fsp.writeFile(
    jobJsonPath(job.id),
    JSON.stringify(job, null, 2)
  );
}

async function appendJobLog(job, message) {
  const line =
    `[${now()}] ${message}`;

  console.log(line);

  try {
    await fsp.appendFile(
      jobLogPath(job.id),
      line + "\n"
    );
  } catch (err) {
    console.error(
      `[JOB ${job.id}] Cannot write build.log:`,
      err.message
    );
  }
}

async function updateJob(job, patch) {
  Object.assign(job, patch);

  job.updatedAt = now();

  await saveJob(job);
}

function validatePackageName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(name);
}

function validateHttpsUrl(url) {
  try {
    const u = new URL(url);

    return u.protocol === "https:";
  } catch {
    return false;
  }
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   PROCESS RUNNER
========================================================= */

function runProcess(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout =
      options.timeout || BUILD_TIMEOUT;

    const started = Date.now();

    appendJobLog(
      job,
      `PROCESS START: ${command} ${args.join(" ")}`
    ).catch(() => {});

    console.log(
      `[JOB ${job.id}] Spawning process`
    );

    console.log(
      `[JOB ${job.id}] command=${command}`
    );

    console.log(
      `[JOB ${job.id}] cwd=${options.cwd || process.cwd()}`
    );

    console.log(
      `[JOB ${job.id}] timeout=${timeout}ms`
    );

    let child;

    try {
      child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,

          GRADLE_USER_HOME:
            "/builder/.gradle",

          JAVA_TOOL_OPTIONS,

          GRADLE_OPTS,

          CI: "true"
        },

        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      });
    } catch (err) {
      appendJobLog(
        job,
        `SPAWN EXCEPTION: ${err.stack || err}`
      ).catch(() => {});

      reject(err);
      return;
    }

    console.log(
      `[JOB ${job.id}] PROCESS CREATED pid=${child.pid}`
    );

    appendJobLog(
      job,
      `PROCESS CREATED pid=${child.pid}`
    ).catch(() => {});

    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;

      const text = chunk.toString();

      process.stdout.write(
        `[GRADLE ${job.id}] ${text}`
      );

      fsp.appendFile(
        jobLogPath(job.id),
        text
      ).catch(() => {});
    });

    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;

      const text = chunk.toString();

      process.stderr.write(
        `[GRADLE-ERR ${job.id}] ${text}`
      );

      fsp.appendFile(
        jobLogPath(job.id),
        text
      ).catch(() => {});
    });

    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (finished) return;

      timedOut = true;

      appendJobLog(
        job,
        `TIMEOUT after ${timeout}ms - sending SIGTERM to PID ${child.pid}`
      ).catch(() => {});

      console.error(
        `[JOB ${job.id}] TIMEOUT PID=${child.pid}`
      );

      try {
        child.kill("SIGTERM");
      } catch {}

      setTimeout(() => {
        if (!finished) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, 10000);

    }, timeout);

    child.on("error", err => {
      console.error(
        `[JOB ${job.id}] CHILD ERROR`,
        err
      );

      appendJobLog(
        job,
        `CHILD ERROR: ${err.stack || err}`
      ).catch(() => {});

      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("exit", (code, signal) => {
      console.log(
        `[JOB ${job.id}] PROCESS EXIT ` +
        `code=${code} signal=${signal}`
      );

      appendJobLog(
        job,
        `PROCESS EXIT code=${code} signal=${signal}`
      ).catch(() => {});
    });

    child.on("close", (code, signal) => {
      if (finished) return;

      finished = true;

      clearTimeout(timer);

      const duration =
        Date.now() - started;

      console.log(
        `[JOB ${job.id}] PROCESS CLOSE ` +
        `code=${code} signal=${signal} ` +
        `duration=${duration}ms`
      );

      appendJobLog(
        job,
        `PROCESS CLOSE code=${code} signal=${signal} duration=${duration}ms stdout=${stdoutBytes}B stderr=${stderrBytes}B`
      ).catch(() => {});

      resolve({
        code,
        signal,
        duration,
        stdoutBytes,
        stderrBytes,
        timedOut
      });
    });
  });
}

/* =========================================================
   BUILD MONITOR
========================================================= */

function startBuildMonitor(job) {
  console.log(
    `[JOB ${job.id}] Starting build monitor`
  );

  return setInterval(async () => {
    try {
      if (activeJobId !== job.id) return;

      const d = systemDiagnostics();

      const line =
        `HEARTBEAT ` +
        `pid=${process.pid} ` +
        `rss=${d.memory.rss}MB ` +
        `heap=${d.memory.heapUsed}MB ` +
        `cpuLoad=${d.cpu.loadAverage.join(",")} ` +
        `diskFree=${d.disk.root.freeMB}MB ` +
        `cgroup=${JSON.stringify(d.cgroup)}`;

      await appendJobLog(job, line);

    } catch (err) {
      console.error(
        `[JOB ${job.id}] Monitor error:`,
        err.message
      );
    }
  }, 5000);
}

/* =========================================================
   TEMPLATE
========================================================= */

async function copyTemplate(destination) {
  console.log(
    `[COPY] Copying template -> ${destination}`
  );

  await fsp.cp(
    TEMPLATE_DIR,
    destination,
    {
      recursive: true,
      filter(source) {
        const relative =
          path.relative(
            TEMPLATE_DIR,
            source
          );

        if (
          relative === ".gradle" ||
          relative.startsWith(".gradle" + path.sep)
        ) {
          return false;
        }

        if (
          relative === "build" ||
          relative.startsWith("build" + path.sep)
        ) {
          return false;
        }

        return true;
      }
    }
  );

  console.log(
    `[COPY] Template copied successfully`
  );
}

/* =========================================================
   BUILD
========================================================= */

async function processBuild(job) {
  const buildStarted = Date.now();

  activeJobId = job.id;

  let monitor = null;

  const workspace =
    path.join(
      WORKSPACES_DIR,
      job.id
    );

  const properties =
    path.join(
      workspace,
      "app.properties"
    );

  try {
    await appendJobLog(
      job,
      "========================================"
    );

    await appendJobLog(
      job,
      `BUILD START V${VERSION}`
    );

    await appendJobLog(
      job,
      `JOB ID: ${job.id}`
    );

    await appendJobLog(
      job,
      `URL: ${job.url}`
    );

    await appendJobLog(
      job,
      `APP NAME: ${job.name}`
    );

    await appendJobLog(
      job,
      `PACKAGE: ${job.packageName}`
    );

    await appendJobLog(
      job,
      `VERSION: ${job.version}`
    );

    await updateJob(job, {
      status: "building",
      startedAt: now(),
      workspace
    });

    monitor = startBuildMonitor(job);

    /* -----------------------------------------
       SYSTEM
    ----------------------------------------- */

    await appendJobLog(
      job,
      `SYSTEM: Node ${process.version}`
    );

    await appendJobLog(
      job,
      `SYSTEM: PID ${process.pid}`
    );

    await appendJobLog(
      job,
      `SYSTEM: platform=${process.platform} arch=${process.arch}`
    );

    await appendJobLog(
      job,
      `SYSTEM: memory=${JSON.stringify(memoryMB())}`
    );

    await appendJobLog(
      job,
      `SYSTEM: disk=${JSON.stringify(diskInfo("/"))}`
    );

    await appendJobLog(
      job,
      `SYSTEM: cgroup=${JSON.stringify(cgroupInfo())}`
    );

    /* -----------------------------------------
       WORKSPACE
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 1/10: Creating workspace"
    );

    await fsp.rm(workspace, {
      recursive: true,
      force: true
    });

    await fsp.mkdir(
      workspace,
      { recursive: true }
    );

    await copyTemplate(workspace);

    await appendJobLog(
      job,
      `STEP 1/10: Workspace ready ${workspace}`
    );

    /* -----------------------------------------
       PROPERTIES
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 2/10: Writing app.properties"
    );

    const content = [
      `app.url=${job.url}`,
      `app.package=${job.packageName}`,
      `app.name=${job.name}`,
      job.iconUrl
        ? `app.icon_url=${job.iconUrl}`
        : ""
    ]
      .filter(Boolean)
      .join("\n") + "\n";

    await fsp.writeFile(
      properties,
      content,
      "utf8"
    );

    await appendJobLog(
      job,
      "STEP 2/10: app.properties written"
    );

    /* -----------------------------------------
       GRADLE
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 3/10: Checking Gradle"
    );

    if (!(await fileExists(GRADLE_BIN))) {
      throw new Error(
        `Gradle not found: ${GRADLE_BIN}`
      );
    }

    await appendJobLog(
      job,
      `Gradle binary found: ${GRADLE_BIN}`
    );

    const gradleVersion =
      await runProcess(
        job,
        GRADLE_BIN,
        ["--version"],
        {
          cwd: workspace,
          timeout: 30000
        }
      );

    if (gradleVersion.code !== 0) {
      throw new Error(
        `Gradle --version failed with code ${gradleVersion.code}`
      );
    }

    await appendJobLog(
      job,
      `Gradle ${GRADLE_VERSION} OK`
    );

    /* -----------------------------------------
       GRADLE BUILD
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 4/10: STARTING ANDROID BUILD"
    );

    await appendJobLog(
      job,
      `Gradle PID will be displayed below`
    );

    await appendJobLog(
      job,
      `JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS}`
    );

    await appendJobLog(
      job,
      `GRADLE_OPTS=${GRADLE_OPTS}`
    );

    await appendJobLog(
      job,
      `BUILD TIMEOUT=${BUILD_TIMEOUT}ms`
    );

    const result =
      await runProcess(
        job,
        GRADLE_BIN,
        [
          "assembleDebug",
          "--no-daemon",
          "--console=plain",
          "--stacktrace",
          "--max-workers=1"
        ],
        {
          cwd: workspace,
          timeout: BUILD_TIMEOUT
        }
      );

    await appendJobLog(
      job,
      `STEP 5/10: Gradle finished code=${result.code} signal=${result.signal}`
    );

    if (result.timedOut) {
      throw new Error(
        `Gradle build timeout after ${BUILD_TIMEOUT}ms`
      );
    }

    if (result.code !== 0) {
      throw new Error(
        `Gradle build failed with exit code ${result.code}`
      );
    }

    /* -----------------------------------------
       APK
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 6/10: Searching APK"
    );

    const generatedApk =
      path.join(
        workspace,
        "app",
        "build",
        "outputs",
        "apk",
        "debug",
        "app-debug.apk"
      );

    if (!(await fileExists(generatedApk))) {
      throw new Error(
        `APK not found: ${generatedApk}`
      );
    }

    const apkStat =
      await fsp.stat(generatedApk);

    await appendJobLog(
      job,
      `APK FOUND size=${Math.round(apkStat.size / 1024)}KB`
    );

    /* -----------------------------------------
       FINAL APK
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 7/10: Copying final APK"
    );

    const finalApk =
      path.join(
        BUILDS_DIR,
        `${job.id}.apk`
      );

    await fsp.copyFile(
      generatedApk,
      finalApk
    );

    await appendJobLog(
      job,
      `FINAL APK: ${finalApk}`
    );

    /* -----------------------------------------
       ZIP
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 8/10: Creating ZIP"
    );

    const finalZip =
      path.join(
        BUILDS_DIR,
        `${job.id}.zip`
      );

    const zipResult =
      await runProcess(
        job,
        "zip",
        [
          "-j",
          finalZip,
          finalApk
        ],
        {
          cwd: BUILDS_DIR,
          timeout: 60000
        }
      );

    if (zipResult.code !== 0) {
      throw new Error(
        `ZIP creation failed with exit code ${zipResult.code}`
      );
    }

    const zipStat =
      await fsp.stat(finalZip);

    await appendJobLog(
      job,
      `ZIP CREATED size=${Math.round(zipStat.size / 1024)}KB`
    );

    /* -----------------------------------------
       FINAL CHECK
    ----------------------------------------- */

    await appendJobLog(
      job,
      "STEP 9/10: Final verification"
    );

    const apkExists =
      await fileExists(finalApk);

    const zipExists =
      await fileExists(finalZip);

    if (!apkExists) {
      throw new Error(
        "Final APK verification failed"
      );
    }

    if (!zipExists) {
      throw new Error(
        "Final ZIP verification failed"
      );
    }

    const duration =
      Date.now() - buildStarted;

    const externalUrl =
      process.env.RENDER_EXTERNAL_URL ||
      `http://localhost:${PORT}`;

    await updateJob(job, {
      status: "completed",

      finishedAt: now(),

      durationMs: duration,

      apk: {
        path: finalApk,
        size: apkStat.size,
        url:
          `${externalUrl}/api/download/${job.id}/apk`
      },

      zip: {
        path: finalZip,
        size: zipStat.size,
        url:
          `${externalUrl}/api/download/${job.id}/zip`
      }
    });

    await appendJobLog(
      job,
      "STEP 10/10: BUILD SUCCESS"
    );

    await appendJobLog(
      job,
      `TOTAL BUILD TIME=${duration}ms`
    );

    await appendJobLog(
      job,
      `APK URL=${externalUrl}/api/download/${job.id}/apk`
    );

    await appendJobLog(
      job,
      `ZIP URL=${externalUrl}/api/download/${job.id}/zip`
    );

    await appendJobLog(
      job,
      `FINAL MEMORY=${JSON.stringify(memoryMB())}`
    );

    await appendJobLog(
      job,
      `FINAL DISK=${JSON.stringify(diskInfo("/"))}`
    );

    await appendJobLog(
      job,
      "========================================"
    );

  } catch (error) {

    const duration =
      Date.now() - buildStarted;

    console.error(
      `[JOB ${job.id}] BUILD FAILED`
    );

    console.error(
      error.stack || error
    );

    await appendJobLog(
      job,
      `BUILD FAILED: ${error.stack || error}`
    );

    await appendJobLog(
      job,
      `FAILURE AFTER=${duration}ms`
    );

    await appendJobLog(
      job,
      `FAILURE MEMORY=${JSON.stringify(memoryMB())}`
    );

    await appendJobLog(
      job,
      `FAILURE DISK=${JSON.stringify(diskInfo("/"))}`
    );

    await appendJobLog(
      job,
      `FAILURE CGROUP=${JSON.stringify(cgroupInfo())}`
    );

    await updateJob(job, {
      status: "failed",
      finishedAt: now(),
      durationMs: duration,
      error: error.stack || String(error)
    });

  } finally {

    if (monitor) {
      clearInterval(monitor);
    }

    activeJobId = null;

    /* Nettoyage workspace */

    try {
      await fsp.rm(
        workspace,
        {
          recursive: true,
          force: true
        }
      );

      console.log(
        `[JOB ${job.id}] Workspace cleaned`
      );

    } catch (err) {

      console.error(
        `[JOB ${job.id}] Workspace cleanup failed:`,
        err.message
      );
    }

    await processQueue();
  }
}

/* =========================================================
   QUEUE
========================================================= */

async function processQueue() {
  if (activeJobId) return;

  const nextId = queue.shift();

  if (!nextId) return;

  const job = jobs.get(nextId);

  if (!job) {
    return processQueue();
  }

  activeJobId = job.id;

  console.log(
    `[QUEUE] Starting job ${job.id}`
  );

  processBuild(job)
    .catch(async err => {

      console.error(
        `[QUEUE] Unexpected processBuild error`,
        err
      );

      try {
        await updateJob(job, {
          status: "failed",
          error: err.stack || String(err),
          finishedAt: now()
        });
      } catch {}
    });
}

/* =========================================================
   REQUEST LOGGING
========================================================= */

app.use((req, res, next) => {

  const started = Date.now();

  const requestId =
    req.headers["rndr-id"] ||
    crypto.randomUUID();

  req.requestId = requestId;

  console.log(
    `[HTTP ${requestId}] ${req.method} ${req.originalUrl}`
  );

  res.on("finish", () => {

    console.log(
      `[HTTP ${requestId}] ${req.method} ${req.originalUrl} ` +
      `status=${res.statusCode} ` +
      `duration=${Date.now() - started}ms`
    );
  });

  next();
});

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (req, res) => {

  res.json({
    success: true,
    service: "gabinarou-webview-apk-builder",
    version: VERSION,
    status: "online",
    activeJob: activeJobId,
    queuedJobs: queue.length,
    uptimeSeconds: Math.round(process.uptime())
  });
});

/* -----------------------------------------
   HEALTH
----------------------------------------- */

app.get("/health", async (req, res) => {

  const gradleExists =
    await fileExists(GRADLE_BIN);

  const platformPath =
    path.join(
      process.env.ANDROID_SDK_ROOT ||
      "/opt/android-sdk",
      "platforms",
      "android-37"
    );

  const buildToolsRoot =
    path.join(
      process.env.ANDROID_SDK_ROOT ||
      "/opt/android-sdk",
      "build-tools"
    );

  let buildTools = [];

  try {
    buildTools =
      (await fsp.readdir(buildToolsRoot))
        .filter(v => v.startsWith("37."));
  } catch {}

  res.status(
    gradleExists ? 200 : 503
  ).json({
    success: gradleExists,

    service:
      "gabinarou-webview-apk-builder",

    version: VERSION,

    status:
      gradleExists
        ? "online"
        : "degraded",

    uptimeSeconds:
      Math.round(process.uptime()),

    activeJob:
      activeJobId,

    queuedJobs:
      queue.length,

    gradle: {
      installed:
        gradleExists,

      version:
        GRADLE_VERSION,

      path:
        GRADLE_BIN
    },

    android: {
      sdkRoot:
        process.env.ANDROID_SDK_ROOT,

      platform37:
        await fileExists(platformPath),

      buildTools37:
        buildTools
    },

    memory:
      memoryMB(),

    disk:
      diskInfo("/"),

    cgroup:
      cgroupInfo(),

    time:
      now()
  });
});

/* -----------------------------------------
   DEBUG
----------------------------------------- */

app.get("/api/debug", async (req, res) => {

  res.json({
    success: true,

    version: VERSION,

    server: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt:
        new Date(startedAt).toISOString()
    },

    queue: {
      activeJobId,
      queuedJobs: queue.length,
      queue
    },

    system:
      systemDiagnostics(),

    gradle: {
      path: GRADLE_BIN,
      version: GRADLE_VERSION,
      exists:
        await fileExists(GRADLE_BIN)
    },

    android: {
      sdkRoot:
        process.env.ANDROID_SDK_ROOT,

      sdkExists:
        await fileExists(
          process.env.ANDROID_SDK_ROOT ||
          "/opt/android-sdk"
        )
    }
  });
});

/* -----------------------------------------
   CREATE BUILD
----------------------------------------- */

app.post("/api/build", async (req, res) => {

  const {
    url,
    name,
    packageName,
    version,
    iconUrl
  } = req.body || {};

  console.log(
    `[BUILD REQUEST ${req.requestId}]`
  );

  console.log(
    JSON.stringify({
      url,
      name,
      packageName,
      version,
      iconUrl
    })
  );

  if (!url ||
      !name ||
      !packageName ||
      !version) {

    return res.status(400).json({
      success: false,
      error:
        "url, name, packageName and version are required"
    });
  }

  if (!validateHttpsUrl(url)) {

    return res.status(400).json({
      success: false,
      error:
        "URL must use HTTPS"
    });
  }

  if (!validatePackageName(packageName)) {

    return res.status(400).json({
      success: false,
      error:
        "Invalid Android package name"
    });
  }

  if (queue.length >= MAX_QUEUE) {

    return res.status(429).json({
      success: false,
      error:
        "Build queue is full",
      maxQueue:
        MAX_QUEUE
    });
  }

  const id =
    crypto.randomBytes(12).toString("hex");

  const job = {
    id,

    status:
      "queued",

    createdAt:
      now(),

    updatedAt:
      now(),

    url,

    name,

    packageName,

    version,

    iconUrl:
      iconUrl || null,

    requestId:
      req.requestId,

    statusUrl:
      `/api/build/${id}`,

    logsUrl:
      `/api/build/${id}/logs`
  };

  await saveJob(job);

  await appendJobLog(
    job,
    `JOB CREATED requestId=${req.requestId}`
  );

  queue.push(id);

  await appendJobLog(
    job,
    `JOB QUEUED position=${queue.length}`
  );

  processQueue();

  res.status(202).json({
    success: true,

    jobId: id,

    status:
      job.status,

    statusUrl:
      `/api/build/${id}`,

    logsUrl:
      `/api/build/${id}/logs`
  });
});

/* -----------------------------------------
   JOB STATUS
----------------------------------------- */

app.get("/api/build/:id", async (req, res) => {

  const job =
    jobs.get(req.params.id);

  if (!job) {

    return res.status(404).json({
      success: false,
      error:
        "Build job not found"
    });
  }

  res.json({
    success: true,
    job
  });
});

/* -----------------------------------------
   JOB LOGS
----------------------------------------- */

app.get("/api/build/:id/logs", async (req, res) => {

  const file =
    jobLogPath(req.params.id);

  if (!(await fileExists(file))) {

    return res.status(404).json({
      success: false,
      error:
        "Build logs not found"
    });
  }

  try {

    const content =
      await fsp.readFile(
        file,
        "utf8"
      );

    res.type("text/plain").send(content);

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* -----------------------------------------
   DOWNLOAD APK
----------------------------------------- */

app.get(
  "/api/download/:id/apk",
  async (req, res) => {

    const job =
      jobs.get(req.params.id);

    if (!job || !job.apk) {

      return res.status(404).json({
        success: false,
        error:
          "APK not available"
      });
    }

    if (!(await fileExists(job.apk.path))) {

      return res.status(404).json({
        success: false,
        error:
          "APK file no longer exists"
      });
    }

    res.download(
      job.apk.path,
      `${job.packageName}.apk`
    );
  }
);

/* -----------------------------------------
   DOWNLOAD ZIP
----------------------------------------- */

app.get(
  "/api/download/:id/zip",
  async (req, res) => {

    const job =
      jobs.get(req.params.id);

    if (!job || !job.zip) {

      return res.status(404).json({
        success: false,
        error:
          "ZIP not available"
      });
    }

    if (!(await fileExists(job.zip.path))) {

      return res.status(404).json({
        success: false,
        error:
          "ZIP file no longer exists"
      });
    }

    res.download(
      job.zip.path,
      `${job.packageName}-android.zip`
    );
  }
);

/* =========================================================
   SIGNAL HANDLING
========================================================= */

let shuttingDown = false;

async function gracefulShutdown(signal) {

  if (shuttingDown) return;

  shuttingDown = true;

  console.error(
    `[PROCESS] ${signal} RECEIVED`
  );

  console.error(
    `[PROCESS] PID=${process.pid}`
  );

  console.error(
    `[PROCESS] activeJob=${activeJobId}`
  );

  logSystem(
    `[PROCESS ${signal}]`
  );

  if (activeJobId) {

    const job =
      jobs.get(activeJobId);

    if (job) {

      try {

        await appendJobLog(
          job,
          `RENDER/PROCESS SHUTDOWN: ${signal}`
        );

        await appendJobLog(
          job,
          `ACTIVE BUILD INTERRUPTED BY PROCESS SHUTDOWN`
        );

        await updateJob(job, {
          status: "failed",
          error:
            `Process received ${signal}`,
          finishedAt: now()
        });

      } catch {}
    }
  }

  server.close(() => {

    console.log(
      "[PROCESS] HTTP server closed"
    );

    process.exit(0);
  });

  setTimeout(() => {

    console.error(
      "[PROCESS] Forced shutdown"
    );

    process.exit(1);

  }, 15000);
}

process.on(
  "SIGTERM",
  () => gracefulShutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => gracefulShutdown("SIGINT")
);

process.on(
  "uncaughtException",
  err => {

    console.error(
      "[PROCESS] UNCAUGHT EXCEPTION"
    );

    console.error(
      err.stack || err
    );

    logSystem(
      "[PROCESS UNCAUGHT]"
    );
  }
);

process.on(
  "unhandledRejection",
  reason => {

    console.error(
      "[PROCESS] UNHANDLED REJECTION"
    );

    console.error(
      reason
    );

    logSystem(
      "[PROCESS REJECTION]"
    );
  }
);

process.on(
  "exit",
  code => {

    console.log(
      `[PROCESS] EXIT code=${code}`
    );

    logSystem(
      "[PROCESS EXIT]"
    );
  }
);

/* =========================================================
   STARTUP
========================================================= */

async function startup() {

  console.log("");
  console.log("========================================");
  console.log(
    `Gabinarou WebView APK Builder v${VERSION}`
  );
  console.log("========================================");

  console.log(
    `PORT: ${PORT}`
  );

  console.log(
    `Host: ${HOST}`
  );

  console.log(
    `API: /api/build`
  );

  console.log(
    `Health: /health`
  );

  console.log(
    `Debug: /api/debug`
  );

  console.log(
    `Gradle: PREINSTALLED`
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
    `Gradle JVM: ${JAVA_TOOL_OPTIONS}`
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

  await ensureDirs();

  console.log(
    `Template exists: ${await fileExists(TEMPLATE_DIR)}`
  );

  console.log(
    `Gradle exists: ${await fileExists(GRADLE_BIN)}`
  );

  console.log(
    `Android SDK: ${process.env.ANDROID_SDK_ROOT}`
  );

  logSystem(
    "[STARTUP]"
  );

  console.log(
    "========================================"
  );

  console.log(
    "Your service is live"
  );

  console.log(
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${PORT}`
  );

  console.log(
    "========================================"
  );
}

const server =
  app.listen(
    PORT,
    HOST,
    async () => {

      try {
        await startup();
      } catch (err) {

        console.error(
          "[STARTUP ERROR]",
          err
        );
      }
    }
  );
