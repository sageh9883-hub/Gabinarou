const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const WORK_DIR = process.env.WORK_DIR || "/tmp/gabinarou-builds";
const BUILD_SCRIPT = process.env.BUILD_SCRIPT || "/builder/build.sh";

fs.mkdirSync(WORK_DIR, { recursive: true });

app.use(express.json({ limit: "10mb" }));

const jobs = new Map();

function timestamp() {
  return new Date().toISOString();
}

function addLog(job, message) {
  const line = `[${timestamp()}] ${message}`;
  job.logs.push(line);
  console.log(line);
}

function createJob() {
  const id = crypto.randomBytes(12).toString("hex");

  const job = {
    id,
    status: "queued",
    createdAt: timestamp(),
    startedAt: null,
    finishedAt: null,
    logs: [],
    output: null,
    error: null
  };

  jobs.set(id, job);
  return job;
}

function startBuild(job, body) {
  job.status = "building";
  job.startedAt = timestamp();

  addLog(job, "========================================");
  addLog(job, "Gabinarou Android WebView APK Builder");
  addLog(job, "========================================");
  addLog(job, `Job ID: ${job.id}`);
  addLog(job, `Build started: ${job.startedAt}`);

  if (body && body.url) {
    addLog(job, `Target URL: ${body.url}`);
  }

  addLog(job, `Build script: ${BUILD_SCRIPT}`);
  addLog(job, `Working directory: ${WORK_DIR}`);

  if (!fs.existsSync(BUILD_SCRIPT)) {
    job.status = "failed";
    job.error = `Build script not found: ${BUILD_SCRIPT}`;
    addLog(job, `ERROR: ${job.error}`);
    job.finishedAt = timestamp();
    return;
  }

  addLog(job, "Starting build process...");

  const env = {
    ...process.env,
    JOB_ID: job.id,
    BUILD_WORK_DIR: path.join(WORK_DIR, job.id),
    TARGET_URL: body?.url || body?.targetUrl || ""
  };

  fs.mkdirSync(env.BUILD_WORK_DIR, { recursive: true });

  const child = spawn("bash", [BUILD_SCRIPT], {
    cwd: env.BUILD_WORK_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  job.process = child;

  child.stdout.on("data", (data) => {
    const text = data.toString();

    text
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => addLog(job, line));
  });

  child.stderr.on("data", (data) => {
    const text = data.toString();

    text
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => addLog(job, `[stderr] ${line}`));
  });

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    addLog(job, `PROCESS ERROR: ${error.message}`);
    job.finishedAt = timestamp();
  });

  child.on("close", (code) => {
    job.finishedAt = timestamp();

    if (code === 0) {
      job.status = "completed";

      addLog(job, "========================================");
      addLog(job, "BUILD SUCCESSFUL");
      addLog(job, `Finished: ${job.finishedAt}`);
      addLog(job, "========================================");

      const possibleApks = [
        path.join(env.BUILD_WORK_DIR, "app-debug.apk"),
        path.join(env.BUILD_WORK_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
        path.join(env.BUILD_WORK_DIR, "build", "outputs", "apk", "debug", "app-debug.apk")
      ];

      for (const apk of possibleApks) {
        if (fs.existsSync(apk)) {
          job.output = apk;
          addLog(job, `APK found: ${apk}`);
          break;
        }
      }

      if (!job.output) {
        addLog(job, "WARNING: Build succeeded but APK was not automatically located.");
      }
    } else {
      job.status = "failed";
      job.error = `Build exited with code ${code}`;

      addLog(job, "========================================");
      addLog(job, `BUILD FAILED - exit code ${code}`);
      addLog(job, `Finished: ${job.finishedAt}`);
      addLog(job, "========================================");
    }

    delete job.process;
  });
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "gabinarou-webview-apk-builder",
    version: "2.0.0",
    status: "online",
    time: timestamp()
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    time: timestamp()
  });
});

app.post("/api/build", (req, res) => {
  const job = createJob();

  addLog(job, "Job created.");
  addLog(job, "Status: queued");

  startBuild(job, req.body || {});

  res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status,
    statusUrl: `/api/build/${job.id}`
  });
});

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
    logs: job.logs,
    output: job.output
      ? `/api/download/${job.id}`
      : null,
    error: job.error
  });
});

app.get("/api/build/:id/logs", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Build job not found"
    });
  }

  res.type("text/plain").send(job.logs.join("\n") + "\n");
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Build job not found"
    });
  }

  if (!job.output || !fs.existsSync(job.output)) {
    return res.status(404).json({
      success: false,
      error: "APK not available"
    });
  }

  res.download(job.output, `gabinarou-${job.id}.apk`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("Gabinarou APK Builder");
  console.log("Server started");
  console.log(`Port: ${PORT}`);
  console.log(`Build script: ${BUILD_SCRIPT}`);
  console.log("========================================");
});

Important : ce fichier suppose que ton "Dockerfile" installe Node/Express et que "/builder/build.sh" existe réellement dans l'image. Donc ne déploie pas encore si ton "Dockerfile" actuel ne correspond pas à ça.

Si tu me donnes maintenant ton "Dockerfile" actuel, je te donne la version compatible "Dockerfile + server.js + build.sh" pour que les logs apparaissent réellement.
