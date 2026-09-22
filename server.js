const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;
const BUILD_SCRIPT = "/builder/build.sh";
const WORK_ROOT = "/tmp/gabinarou-builds";

fs.mkdirSync(WORK_ROOT, { recursive: true });

app.use(express.json({ limit: "10mb" }));

const jobs = new Map();

/* =========================================================
   UTILITAIRES
========================================================= */

function now() {
  return new Date().toISOString();
}

function addLog(job, message) {
  const line = `[${now()}] ${message}`;

  job.logs.push(line);

  // Important : apparaît également dans les logs Render
  process.stdout.write(line + "\n");
}

function createJob(body) {
  const id = crypto.randomBytes(12).toString("hex");

  const jobDir = path.join(WORK_ROOT, id);

  fs.mkdirSync(jobDir, {
    recursive: true
  });

  const job = {
    id,
    status: "queued",

    createdAt: now(),
    startedAt: null,
    finishedAt: null,

    logs: [],

    output: null,
    error: null,

    url: body?.url || body?.targetUrl || "",
    packageName: body?.package || body?.appPackage || "com.example.generatedapp",
    appName: body?.name || body?.appName || "Generated App",
    iconUrl: body?.icon || body?.iconUrl || "",

    workDir: jobDir,
    process: null
  };

  jobs.set(id, job);

  return job;
}

/* =========================================================
   BUILD
========================================================= */

function startBuild(job) {
  job.status = "building";
  job.startedAt = now();

  addLog(job, "==============================================");
  addLog(job, "GABINAROU ANDROID WEBVIEW APK BUILDER");
  addLog(job, "==============================================");

  addLog(job, `Job ID       : ${job.id}`);
  addLog(job, `URL          : ${job.url || "non définie"}`);
  addLog(job, `PACKAGE      : ${job.packageName}`);
  addLog(job, `APP NAME     : ${job.appName}`);
  addLog(job, `ICON         : ${job.iconUrl || "aucune"}`);
  addLog(job, `WORK DIR     : ${job.workDir}`);
  addLog(job, `BUILD SCRIPT : ${BUILD_SCRIPT}`);

  /* Vérification du script */

  if (!fs.existsSync(BUILD_SCRIPT)) {
    job.status = "failed";
    job.error = `Build script introuvable: ${BUILD_SCRIPT}`;
    job.finishedAt = now();

    addLog(job, `ERROR: ${job.error}`);

    return;
  }

  addLog(job, "Build script trouvé.");
  addLog(job, "Démarrage de Gradle...");
  addLog(job, "Les logs Gradle seront transmis en temps réel.");

  const env = {
    ...process.env,

    JOB_ID: job.id,

    BUILD_WORK_DIR: job.workDir,

    TARGET_URL: job.url,

    APP_URL: job.url,

    APP_PACKAGE: job.packageName,

    APP_NAME: job.appName,

    APP_ICON_URL: job.iconUrl
  };

  const child = spawn(
    "bash",
    [BUILD_SCRIPT],
    {
      cwd: job.workDir,
      env,

      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  job.process = child;

  /* =======================================================
     STDOUT
  ======================================================= */

  child.stdout.on("data", (data) => {
    const output = data.toString();

    output
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        addLog(job, line);
      });
  });

  /* =======================================================
     STDERR
  ======================================================= */

  child.stderr.on("data", (data) => {
    const output = data.toString();

    output
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        addLog(job, `[stderr] ${line}`);
      });
  });

  /* =======================================================
     PROCESS ERROR
  ======================================================= */

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = now();

    addLog(job, `PROCESS ERROR: ${error.message}`);

    job.process = null;
  });

  /* =======================================================
     PROCESS TERMINATED
  ======================================================= */

  child.on("close", (code) => {
    job.finishedAt = now();

    job.process = null;

    if (code !== 0) {
      job.status = "failed";
      job.error = `Build exited with code ${code}`;

      addLog(job, "==============================================");
      addLog(job, `BUILD FAILED - EXIT CODE ${code}`);
      addLog(job, "==============================================");

      return;
    }

    /* =====================================================
       RECHERCHE APK
    ===================================================== */

    const possibleApks = [
      path.join(
        job.workDir,
        "output",
        "app-debug.apk"
      ),

      path.join(
        job.workDir,
        "app",
        "build",
        "outputs",
        "apk",
        "debug",
        "app-debug.apk"
      )
    ];

    let apk = null;

    for (const candidate of possibleApks) {
      if (fs.existsSync(candidate)) {
        apk = candidate;
        break;
      }
    }

    if (!apk) {
      job.status = "failed";
      job.error = "Build terminé mais APK introuvable.";

      addLog(job, "==============================================");
      addLog(job, "ERROR: APK INTROUVABLE");
      addLog(job, "==============================================");

      return;
    }

    job.output = apk;
    job.status = "completed";

    const size = fs.statSync(apk).size;

    addLog(job, "==============================================");
    addLog(job, "BUILD SUCCESSFUL");
    addLog(job, `APK: ${apk}`);
    addLog(job, `Size: ${Math.round(size / 1024 / 1024 * 100) / 100} MB`);
    addLog(job, `Finished: ${job.finishedAt}`);
    addLog(job, "==============================================");
  });
}

/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "gabinarou-webview-apk-builder",
    version: "2.0.0",
    status: "online",
    time: now()
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    time: now()
  });
});

/* =========================================================
   CREATE BUILD
========================================================= */

app.post("/api/build", (req, res) => {
  try {
    const job = createJob(req.body || {});

    addLog(job, "Job created.");
    addLog(job, "Status: queued");

    /*
     * On répond immédiatement au client.
     * Le build continue en arrière-plan.
     */

    res.status(202).json({
      success: true,

      jobId: job.id,

      status: job.status,

      statusUrl: `/api/build/${job.id}`,

      logsUrl: `/api/build/${job.id}/logs`
    });

    /*
     * Démarrage après l'envoi de la réponse.
     */

    setImmediate(() => {
      startBuild(job);
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   BUILD STATUS + LOGS
========================================================= */

app.get("/api/build/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Build job not found"
    });
  }

  res.json({
    success: true,

    jobId: job.id,

    status: job.status,

    createdAt: job.createdAt,

    startedAt: job.startedAt,

    finishedAt: job.finishedAt,

    url: job.url,

    logs: job.logs,

    output: job.output
      ? `/api/download/${job.id}`
      : null,

    error: job.error
  });
});

/* =========================================================
   LOGS TEXT
========================================================= */

app.get("/api/build/:id/logs", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).send("Build job not found");
  }

  res.setHeader(
    "Content-Type",
    "text/plain; charset=utf-8"
  );

  res.send(
    job.logs.join("\n") + "\n"
  );
});

/* =========================================================
   DOWNLOAD APK
========================================================= */

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Build job not found"
    });
  }

  if (!job.output) {
    return res.status(404).json({
      success: false,
      error: "APK not available yet"
    });
  }

  if (!fs.existsSync(job.output)) {
    return res.status(404).json({
      success: false,
      error: "APK file no longer exists"
    });
  }

  res.download(
    job.output,
    `gabinarou-${job.id}.apk`
  );
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "=============================================="
    );

    console.log(
      "GABINAROU APK BUILDER SERVER"
    );

    console.log(
      `Server listening on port ${PORT}`
    );

    console.log(
      `Build script: ${BUILD_SCRIPT}`
    );

    console.log(
      "=============================================="
    );
  }
);
