/**
 * downloader.js
 *
 * Polls GitHub RAW docs/version.json; if version changed, downloads docs/<channel>.html.
 * Runs forever: checks every 5 minutes.
 *
 * HTTP/HTTPS proxy support only (undici ProxyAgent).
 *
 * Proxy priority order:
 *   1) config.proxy (below)
 *   2) proxy.env file next to this script: PROXY=http://user:pass@host:port
 *   3) env var: PROXY=http://user:pass@host:port
 */

const fs = require("fs");
const path = require("path");
const { setGlobalDispatcher, ProxyAgent } = require("undici");

// Node 18+ has global fetch (undici)
const fetchFn = global.fetch;

// ----------------------
// Config
// ----------------------
const config = {
  // GitHub raw base:
  // https://github.com/<owner>/<repo>/raw/refs/heads/<branch>/<path>
  repoRawBase: "https://github.com/VAHHABSY/newsfetcher/raw/refs/heads/main",

  // Where to store downloaded files locally
  outputDir: path.join(__dirname, "downloaded_docs"),

  // Optional hardcoded proxy; leave null to use proxy.env or PROXY env var.
  // Example: "http://127.0.0.1:8080"
  // Example: "http://user:pass@127.0.0.1:8080"
  proxy: null,

  // Local file where we store last seen version
  localVersionFile: path.join(__dirname, ".last_version.json"),

  // Network timeouts
  timeoutMs: 30_000,

  // Poll interval (5 minutes)
  pollIntervalMs: 5 * 60 * 1000,
};

// ----------------------
// Helpers
// ----------------------
function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLastVersion() {
  if (!fs.existsSync(config.localVersionFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.localVersionFile, "utf-8"));
  } catch {
    return null;
  }
}

function writeLastVersion(obj) {
  fs.writeFileSync(config.localVersionFile, JSON.stringify(obj, null, 2), "utf-8");
}

function loadProxyFromProxyEnvFile() {
  const proxyEnvPath = path.join(__dirname, "proxy.env");
  if (!fs.existsSync(proxyEnvPath)) return null;

  const raw = fs.readFileSync(proxyEnvPath, "utf-8");
  const match = raw.match(/^\s*PROXY\s*=\s*(.+?)\s*$/m);
  if (!match) return null;

  // strip surrounding quotes if present
  return match[1].replace(/^['"]|['"]$/g, "");
}

function getProxy() {
  const proxyFromFile = loadProxyFromProxyEnvFile();
  const proxyFromEnv = process.env.PROXY || process.env.proxy;
  return config.proxy || proxyFromFile || proxyFromEnv || null;
}

/**
 * Applies proxy (if set) and returns fetch implementation.
 * Note: With undici ProxyAgent we set a global dispatcher.
 */
function setupHttpProxyAndGetFetch() {
  const proxy = getProxy();

  if (!proxy) {
    console.log(`[${nowIso()}] Proxy not set (direct connection).`);
    return fetchFn;
  }

  const lower = proxy.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    throw new Error(
      `Proxy must be HTTP/HTTPS (you asked to revert to http proxy).\n` +
        `Got: ${proxy}\n` +
        `Use: http://host:port  or  http://user:pass@host:port`
    );
  }

  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log(`[${nowIso()}] HTTP proxy enabled: ${proxy}`);
  return fetchFn;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function downloadJson(fetchImpl, url) {
  const res = await fetchWithTimeout(fetchImpl, url, config.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function downloadText(fetchImpl, url) {
  const res = await fetchWithTimeout(fetchImpl, url, config.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ----------------------
// One poll iteration
// ----------------------
async function checkOnce(fetchImpl) {
  const versionUrl = `${config.repoRawBase}/docs/version.json`;
  console.log(`[${nowIso()}] Checking: ${versionUrl}`);

  const remoteVersion = await downloadJson(fetchImpl, versionUrl);

  if (
    !remoteVersion ||
    typeof remoteVersion.version === "undefined" ||
    !Array.isArray(remoteVersion.channels)
  ) {
    throw new Error("version.json format unexpected. Expected {version, channels[]}");
  }

  const last = readLastVersion();
  const lastVersionNumber = last?.version ?? null;

  if (lastVersionNumber === remoteVersion.version) {
    console.log(`[${nowIso()}] No update. Version unchanged: ${remoteVersion.version}`);
    return;
  }

  console.log(
    `[${nowIso()}] Update found. Old: ${lastVersionNumber ?? "none"}  New: ${remoteVersion.version}`
  );

  ensureDir(config.outputDir);

  for (const ch of remoteVersion.channels) {
    const pageUrl = `${config.repoRawBase}/docs/${encodeURIComponent(ch)}.html`;
    const outPath = path.join(config.outputDir, `${ch}.html`);

    console.log(`[${nowIso()}] Downloading: ${pageUrl}`);
    const html = await downloadText(fetchImpl, pageUrl);

    fs.writeFileSync(outPath, html, "utf-8");
    console.log(`[${nowIso()}] Saved: ${outPath}`);
  }

  // Save version.json alongside downloads
  fs.writeFileSync(
    path.join(config.outputDir, "version.json"),
    JSON.stringify(remoteVersion, null, 2),
    "utf-8"
  );

  writeLastVersion({
    version: remoteVersion.version,
    generated_at: remoteVersion.generated_at || null,
    checked_at: nowIso(),
  });

  console.log(`[${nowIso()}] Update download complete.`);
}

// ----------------------
// Forever loop
// ----------------------
async function runForever() {
  if (!fetchFn) {
    throw new Error("Global fetch not found. Use Node 18+.");
  }

  while (true) {
    try {
      // re-read proxy each iteration (so editing proxy.env takes effect)
      const fetchImpl = setupHttpProxyAndGetFetch();
      await checkOnce(fetchImpl);
    } catch (err) {
      console.error(`[${nowIso()}] Poll failed:`, err?.message || err);
    }

    console.log(`[${nowIso()}] Sleeping ${Math.round(config.pollIntervalMs / 1000)}s...`);
    await sleep(config.pollIntervalMs);
  }
}

runForever().catch((err) => {
  console.error(`[${nowIso()}] Fatal:`, err);
  process.exit(1);
});
