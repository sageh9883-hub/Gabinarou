const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";

const VERSION = "3.3.0";

const BUILDER_DIR = "/builder";
const TEMPLATE_DIR = path.join(BUILDER_DIR, "template");
const JOBS_DIR = path.join(BUILDER_DIR, "jobs");
const BUILDS_DIR = path.join(BUILDER_DIR, "builds");
const WORKSPACES_DIR = path.join(BUILDER_DIR, "workspaces");
const GRADLE_CACHE_DIR = path.join(BUILDER_DIR, ".gradle");

const GRADLE_BIN = "/opt/gradle/gradle-9.7.1/bin/gradle";

const JAVA_TOOL_OPTIONS =
  "-Xmx256m -XX:MaxMetaspaceSize=128m";

const GRADLE_OPTS =
  "-Dorg.gradle.jvmargs=-Xmx256m -Dorg.gradle.daemon=false";

const BUILD_TIMEOUT =
  Number(process.env.BUILD_TIMEOUT_MS || 600000);

const MAX_QUEUE = Number(process.env.MAX_QUEUE || 3);

let queue = Promise.resolve();
let queuedBuilds = 0;

app.use(cors());
app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);
app.use(express.json({ limit: "2mb" }));

// ============================================================
// UTILITIES
// ============================================================

function now() {
  return new Date().toISOString();
}

function memoryInfo() {
  const m = process.memoryUsage();

  return {
    rss: `${Math.round(m.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(m.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(m.heapTotal / 1024 / 1024)}MB`,
    external: `${Math.round(m.external / 1024 / 1024)}MB`
  };
}

function logMemory(id) {
  const m = memoryInfo();

  console.log(
    `[BUILD ${id}] Node memory: ` +
    `RSS=${m.rss} ` +
    `HeapUsed=${m.heapUsed} ` +
    `HeapTotal=${m.heapTotal} ` +
    `External=${m.external}`
  );
}

function log(id, message) {
  console.log(`[BUILD ${id}] ${message}`);
}

function errorLog(id, message) {
  console.error(`[BUILD ${id}] ${message}`);
}

function safeName(value, fallback) {
  const result = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);

  return result || fallback;
}

function validPackageName(pkg) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg);
}

function isHttpsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function saveJob(job) {
  await fsp.writeFile(
    jobPath(job.id),
    JSON.stringify(job, null, 2)
  );
}

async function loadJob(id) {
  const file = jobPath(id);

  try {
    const data = await fsp.readFile(file, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function ensureDirectories() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(BUILDS_DIR, { recursive: true });
  await fsp.mkdir(WORKSPACES_DIR, { recursive: true });
  await fsp.mkdir(GRADLE_CACHE_DIR, { recursive: true });
}

function renderDownloadUrl(req, id) {
  const base =
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`;

  return `${base}/api/download/${id}`;
}

// ============================================================
// PROCESS EXECUTION
// ============================================================

function runProcess({
  id,
  command,
  args,
  cwd,
  env,
  timeout = BUILD_TIMEOUT
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    log(id, `PROCESS START: ${command}`);
    log(id, `ARGS: ${args.join(" ")}`);
    log(id, `CWD: ${cwd}`);

    let child;

    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      errorLog(id, `SPAWN EXCEPTION: ${err.stack || err}`);
      reject(err);
      return;
    }

    log(id, `PROCESS CREATED. PID=${child.pid}`);

    let stdout = "";
    let stderr = "";

    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      errorLog(
        id,
        `PROCESS TIMEOUT after ${timeout}ms. Sending SIGTERM.`
      );

      try {
        child.kill("SIGTERM");
      } catch (err) {
        errorLog(
          id,
          `Unable to SIGTERM process: ${err.message}`
        );
      }

      setTimeout(() => {
        if (finished) return;

        errorLog(
          id,
          "Process still alive after SIGTERM. Sending SIGKILL."
        );

        try {
          child.kill("SIGKILL");
        } catch {}
      }, 10000);
    }, timeout);

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;

      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          console.log(`[GRADLE ${id}] ${line}`);
        }
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;

      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          console.error(`[GRADLE-ERR ${id}] ${line}`);
        }
      }
    });

    child.on("error", (err) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      errorLog(
        id,
        `PROCESS ERROR: ${err.stack || err}`
      );

      reject(err);
    });

    child.on("exit", (code, signal) => {
      log(
        id,
        `PROCESS EXIT: code=${code} signal=${signal || "none"}`
      );
    });

    child.on("close", (code, signal) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      const duration = Date.now() - startedAt;

      log(
        id,
        `PROCESS CLOSED: code=${code} signal=${signal || "none"} duration=${duration}ms`
      );

      if (code === 0) {
        resolve({
          code,
          signal,
          stdout,
          stderr,
          duration
        });
      } else {
        const error = new Error(
          `Process exited with code=${code}, signal=${signal || "none"}`
        );

        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        error.duration = duration;

        reject(error);
      }
    });
  });
}

// ============================================================
// TEMPLATE COPY
// ============================================================

async function createWorkspace(id) {
  const workspace = path.join(WORKSPACES_DIR, id);

  log(id, `Creating isolated workspace: ${workspace}`);

  await fsp.rm(workspace, {
    recursive: true,
    force: true
  });

  await fsp.cp(TEMPLATE_DIR, workspace, {
    recursive: true,
    filter(source) {
      const relative = path.relative(
        TEMPLATE_DIR,
        source
      );

      if (!relative) return true;

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
  });

  log(id, "Android template copied successfully.");

  return workspace;
}

// ============================================================
// BUILD
// ============================================================

async function processBuild(job) {
  const id = job.id;

  const startedAt = Date.now();

  let workspace = null;

  try {
    console.log("");
    console.log("========================================");
    log(id, "GABINAROU APK BUILD START");
    log(id, `VERSION ${VERSION}`);
    console.log("========================================");

    log(id, `URL: ${job.url}`);
    log(id, `Name: ${job.name}`);
    log(id, `Package: ${job.packageName}`);
    log(id, `Version: ${job.version}`);
    log(id, `Icon: ${job.iconUrl || "(none)"}`);

    logMemory(id);

    job.status = "progress";
    job.startedAt = now();
    await saveJob(job);

    // --------------------------------------------------------
    // A
    // --------------------------------------------------------

    log(id, "Step A: checking Android template...");

    if (!fs.existsSync(TEMPLATE_DIR)) {
      throw new Error(
        `Android template not found: ${TEMPLATE_DIR}`
      );
    }

    log(id, `Template found: ${TEMPLATE_DIR}`);

    // --------------------------------------------------------
    // B
    // --------------------------------------------------------

    log(id, "Step B: creating isolated build workspace...");

    workspace = await createWorkspace(id);

    // --------------------------------------------------------
    // C
    // --------------------------------------------------------

    log(id, "Step C: writing app.properties...");

    const properties = [
      `app.url=${job.url}`,
      `app.package=${job.packageName}`,
      `app.name=${job.name}`,
      `app.icon_url=${job.iconUrl || ""}`
    ].join("\n") + "\n";

    const propertiesPath =
      path.join(workspace, "app.properties");

    await fsp.writeFile(
      propertiesPath,
      properties,
      "utf8"
    );

    log(
      id,
      `app.properties written: ${propertiesPath}`
    );

    console.log(
      `[BUILD ${id}] app.properties content:\n${properties}`
    );

    // --------------------------------------------------------
    // D
    // --------------------------------------------------------

    log(id, "Step D: checking Gradle installation...");

    if (!fs.existsSync(GRADLE_BIN)) {
      throw new Error(
        `Preinstalled Gradle not found: ${GRADLE_BIN}`
      );
    }

    log(id, `Gradle found: ${GRADLE_BIN}`);

    // --------------------------------------------------------
    // E
    // --------------------------------------------------------

    log(id, "Step E: checking Gradle version...");

    await runProcess({
      id,
      command: GRADLE_BIN,
      args: ["--version"],
      cwd: workspace,
      env: {
        ...process.env,
        GRADLE_USER_HOME: GRADLE_CACHE_DIR,
        JAVA_TOOL_OPTIONS,
        GRADLE_OPTS
      },
      timeout: 60000
    });

    // --------------------------------------------------------
    // F
    // --------------------------------------------------------

    log(id, "Step F: starting Android compilation.");

    log(id, "IMPORTANT: Gradle is PREINSTALLED.");
    log(id, "No Gradle distribution download should occur.");

    logMemory(id);

    const gradleArgs = [
      "assembleDebug",
      "--no-daemon",
      "--console=plain",
      "--stacktrace",
      "--max-workers=1"
    ];

    console.log("========================================");
    log(id, "GRADLE BUILD START");
    console.log("========================================");

    const gradleResult = await runProcess({
      id,
      command: GRADLE_BIN,
      args: gradleArgs,
      cwd: workspace,
      env: {
        ...process.env,
        GRADLE_USER_HOME: GRADLE_CACHE_DIR,
        JAVA_TOOL_OPTIONS,
        GRADLE_OPTS
      },
      timeout: BUILD_TIMEOUT
    });

    log(
      id,
      `Gradle completed successfully in ${gradleResult.duration}ms`
    );

    logMemory(id);

    // --------------------------------------------------------
    // G
    // --------------------------------------------------------

    log(id, "Step G: searching for generated APK...");

    const possibleApks = [
      path.join(
        workspace,
        "app",
        "build",
        "outputs",
        "apk",
        "debug",
        "app-debug.apk"
      ),
      path.join(
        workspace,
        "app",
        "build",
        "outputs",
        "apk",
        "release",
        "app-release.apk"
      )
    ];

    let apkSource = null;

    for (const candidate of possibleApks) {
      if (fs.existsSync(candidate)) {
        apkSource = candidate;
        break;
      }
    }

    if (!apkSource) {
      throw new Error(
        "APK build finished but APK file was not found."
      );
    }

    const apkName =
      `${safeName(job.name, "app")}-${job.id}.apk`;

    const apkDestination =
      path.join(BUILDS_DIR, apkName);

    await fsp.copyFile(
      apkSource,
      apkDestination
    );

    const apkStat =
      await fsp.stat(apkDestination);

    log(
      id,
      `APK created: ${apkDestination}`
    );

    log(
      id,
      `APK size: ${Math.round(apkStat.size / 1024)} KB`
    );

    // --------------------------------------------------------
    // H
    // --------------------------------------------------------

    log(id, "Step H: creating ZIP package...");

    const zipName =
      `${safeName(job.name, "app")}-${job.id}.zip`;

    const zipDestination =
      path.join(BUILDS_DIR, zipName);

    const zipResult = await runProcess({
      id,
      command: "zip",
      args: [
        "-j",
        zipDestination,
        apkDestination
      ],
      cwd: BUILDS_DIR,
      env: process.env,
      timeout: 120000
    });

    log(
      id,
      `ZIP process completed in ${zipResult.duration}ms`
    );

    const zipStat =
      await fsp.stat(zipDestination);

    log(
      id,
      `ZIP size: ${Math.round(zipStat.size / 1024)} KB`
    );

    // --------------------------------------------------------
    // I
    // --------------------------------------------------------

    job.status = "completed";

    job.completedAt = now();

    job.durationMs =
      Date.now() - startedAt;

    job.apk = {
      filename: apkName,
      path: apkDestination,
      size: apkStat.size
    };

    job.zip = {
      filename: zipName,
      path: zipDestination,
      size: zipStat.size
    };

    await saveJob(job);

    console.log("========================================");
    log(id, "BUILD COMPLETED SUCCESSFULLY");
    log(id, `Duration: ${job.durationMs}ms`);
    log(id, `APK: ${apkName}`);
    log(id, `ZIP: ${zipName}`);
    console.log("========================================");

    logMemory(id);

  } catch (error) {
    job.status = "failed";
    job.completedAt = now();
    job.durationMs =
      Date.now() - startedAt;

    job.error = {
      message: error.message,
      code: error.code || null,
      signal: error.signal || null,
      stack: error.stack || null
    };

    if (error.stdout) {
      job.error.stdout =
        error.stdout.slice(-10000);
    }

    if (error.stderr) {
      job.error.stderr =
        error.stderr.slice(-10000);
    }

    await saveJob(job);

    console.error("");
    console.error("========================================");
    errorLog(id, "BUILD FAILED");
    errorLog(id, error.stack || error);
    console.error("========================================");

    logMemory(id);

  } finally {
    if (workspace) {
      try {
        await fsp.rm(workspace, {
          recursive: true,
          force: true
        });

        log(
          id,
          "Build workspace cleaned."
        );
      } catch (cleanupError) {
        errorLog(
          id,
          `Workspace cleanup failed: ${cleanupError.message}`
        );
      }
    }
  }
}

// ============================================================
// BUILD QUEUE
// ============================================================

function enqueueBuild(job) {
  queuedBuilds++;

  const position = queuedBuilds;

  log(
    job.id,
    `Build added to queue. Position=${position}`
  );

  queue = queue
    .then(async () => {
      queuedBuilds--;

      await processBuild(job);
    })
    .catch((error) => {
      console.error(
        `[BUILD ${job.id}] QUEUE ERROR`,
        error
      );
    });

  return queue;
}

// ============================================================
// HEALTH
// ============================================================

app.get("/health", async (req, res) => {
  let gradleInstalled = false;

  try {
    gradleInstalled =
      fs.existsSync(GRADLE_BIN);
  } catch {}

  res.json({
    success: true,
    service: "gabinarou-webview-apk-builder",
    version: VERSION,
    status: "online",
    time: now(),
    gradle: {
      installed: gradleInstalled,
      version: "9.7.1",
      path: GRADLE_BIN
    },
    build: {
      timeoutMs: BUILD_TIMEOUT,
      maxWorkers: 1
    },
    memory: memoryInfo(),
    queue: queuedBuilds
  });
});

// ============================================================
// BUILDER INFO
// ============================================================

app.get("/builder", (req, res) => {
  res.json({
    success: true,
    service: "Gabinarou WebView APK Builder",
    version: VERSION,
    status: "online",
    endpoints: {
      health: "/health",
      build: "POST /api/build",
      status: "GET /api/build/:id",
      download: "GET /api/download/:id"
    },
    gradle: {
      version: "9.7.1",
      preinstalled: true
    }
  });
});

// ============================================================
// TEMPLATE INFO
// ============================================================

app.get("/builder/template", async (req, res) => {
  res.json({
    success: true,
    template: TEMPLATE_DIR,
    exists: fs.existsSync(TEMPLATE_DIR),
    gradle: {
      version: "9.7.1",
      executable: GRADLE_BIN,
      exists: fs.existsSync(GRADLE_BIN)
    }
  });
});

// ============================================================
// CREATE BUILD
// ============================================================

app.post("/api/build", async (req, res) => {
  try {
    if (queuedBuilds >= MAX_QUEUE) {
      return res.status(429).json({
        success: false,
        error: "Build queue is full."
      });
    }

    const {
      url,
      name,
      packageName,
      version = "1.0.0",
      iconUrl = ""
    } = req.body || {};

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "url is required"
      });
    }

    if (!isHttpsUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "url must use HTTPS"
      });
    }

    if (!packageName) {
      return res.status(400).json({
        success: false,
        error: "packageName is required"
      });
    }

    if (!validPackageName(packageName)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Android packageName"
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "name is required"
      });
    }

    if (iconUrl && !isHttpsUrl(iconUrl)) {
      return res.status(400).json({
        success: false,
        error: "iconUrl must use HTTPS"
      });
    }

    const id = crypto
      .randomBytes(12)
      .toString("hex");

    const job = {
      id,
      status: "queued",

      createdAt: now(),

      url,
      name: String(name).slice(0, 100),
      packageName,
      version: String(version).slice(0, 30),
      iconUrl,

      apk: null,
      zip: null,
      error: null
    };

    await saveJob(job);

    console.log("");
    console.log("========================================");
    console.log(`NEW BUILD JOB: ${id}`);
    console.log(`URL: ${url}`);
    console.log(`PACKAGE: ${packageName}`);
    console.log("========================================");

    enqueueBuild(job);

    const statusUrl =
      `/api/build/${id}`;

    res.status(202).json({
      success: true,
      jobId: id,
      status: "queued",
      statusUrl
    });

  } catch (error) {
    console.error(
      "CREATE BUILD ERROR:",
      error.stack || error
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// BUILD STATUS
// ============================================================

app.get("/api/build/:id", async (req, res) => {
  try {
    const job =
      await loadJob(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Build job not found"
      });
    }

    const response = {
      success: true,
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      durationMs: job.durationMs || null
    };

    if (job.status === "completed") {
      response.apk = {
        filename: job.apk.filename,
        size: job.apk.size,
        downloadUrl:
          renderDownloadUrl(
            req,
            job.id
          )
      };

      response.zip = {
        filename: job.zip.filename,
        size: job.zip.size,
        downloadUrl:
          renderDownloadUrl(
            req,
            job.id
          )
      };
    }

    if (job.status === "failed") {
      response.error = job.error;
    }

    res.json(response);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// DOWNLOAD
// ============================================================

app.get("/api/download/:id", async (req, res) => {
  try {
    const job =
      await loadJob(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Build job not found"
      });
    }

    if (job.status !== "completed") {
      return res.status(409).json({
        success: false,
        error: "Build is not completed yet.",
        status: job.status
      });
    }

    const requested =
      req.query.file || "zip";

    let filePath;
    let filename;

    if (requested === "apk") {
      filePath = job.apk.path;
      filename = job.apk.filename;
    } else {
      filePath = job.zip.path;
      filename = job.zip.filename;
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: "Build file no longer exists."
      });
    }

    res.download(
      filePath,
      filename
    );

  } catch (error) {
    console.error(
      "DOWNLOAD ERROR:",
      error.stack || error
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// GLOBAL ERROR HANDLERS
// ============================================================

process.on("uncaughtException", (error) => {
  console.error("");
  console.error("========================================");
  console.error("UNCAUGHT EXCEPTION");
  console.error(error.stack || error);
  console.error("========================================");
});

process.on("unhandledRejection", (reason) => {
  console.error("");
  console.error("========================================");
  console.error("UNHANDLED REJECTION");
  console.error(reason);
  console.error("========================================");
});

process.on("SIGTERM", () => {
  console.error(
    `[${now()}] SIGTERM received.`
  );
});

process.on("SIGINT", () => {
  console.error(
    `[${now()}] SIGINT received.`
  );
});

process.on("exit", (code) => {
  console.log(
    `[${now()}] Node process exiting. code=${code}`
  );
});

// ============================================================
// START
// ============================================================

async function start() {
  await ensureDirectories();

  console.log("");
  console.log("========================================");
  console.log(`Gabinarou WebView APK Builder v${VERSION}`);
  console.log("========================================");
  console.log(`PORT: ${PORT}`);
  console.log(`Host: ${HOST}`);
  console.log("API: /api/build");
  console.log("Health: /health");
  console.log("Gradle: PREINSTALLED");
  console.log("Gradle version: 9.7.1");
  console.log(`Gradle path: ${GRADLE_BIN}`);
  console.log("Gradle workers: 1");
  console.log("Gradle JVM heap: 256MB");
  console.log(`Build timeout: ${BUILD_TIMEOUT}ms`);
  console.log("========================================");

  if (fs.existsSync(GRADLE_BIN)) {
    console.log(
      "✓ Preinstalled Gradle detected."
    );
  } else {
    console.error(
      "✗ WARNING: Preinstalled Gradle NOT FOUND."
    );
  }

  app.listen(PORT, HOST, () => {
    console.log("");
    console.log("Your service is live");
    console.log(
      process.env.RENDER_EXTERNAL_URL ||
      `http://${HOST}:${PORT}`
    );
    console.log("");
  });
}

start().catch((error) => {
  console.error(
    "FATAL STARTUP ERROR:",
    error.stack || error
  );

  process.exit(1);
});
