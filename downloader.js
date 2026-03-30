/**
 * downloader.js
 *
 * Usage:
 *   node downloader.js
 *
 * Optional:
 *   - Create proxy.env next to this file, containing:
 *       PROXY=http://user:pass@host:port
 *     or
 *       PROXY=http://host:port
 *
 *   - Or set an environment variable:
 *       PROXY=http://host:port node downloader.js
 */

const fs = require("fs");
const path = require("path");
const { setGlobalDispatcher, ProxyAgent } = require("undici");

// ----------------------
// Config (edit as needed)
// ----------------------
const config = {
  // GitHub repo raw base:
  // main branch raw format:
  // https://github.com/<owner>/<repo>/raw/refs/heads/<branch>/<path>
  repoRawBase:
    "https://github.com/VAHHABSY/newsfetcher/raw/refs/heads/main",

  // Where to store downloaded files locally
  outputDir: path.join(__dirname, "downloaded_docs"),

  // If you want to hardcode a proxy here, put it as a string; otherwise leave null
  // Example: "http://user:pass@1.2.3.4:8080"
  proxy: null,

  // Local file where we store last seen version
  localVersionFile: path.join(__dirname, ".last_version.json"),

  // Timeouts (ms)
  timeoutMs: 30_000,
};

// ----------------------
// Proxy loading (proxy.env / env var / config)
// ----------------------
function loadProxyFromProxyEnvFile() {
  const proxyEnvPath = path.join(__dirname, "proxy.env");
  if (!fs.existsSync(proxyEnvPath)) return null;

  const raw = fs.readFileSync(proxyEnvPath, "utf-8");
  // Accept formats like:
  //   PROXY=http://host:port
  //   PROXY = http://host:port
  const match = raw.match(/^\s*PROXY\s*=\s*(.+?)\s*$/m);
  if (!match) return null;

  // Strip surrounding quotes if any
  return match[1].replace(/^['"]|['"]$/g, "");
}

function setupProxy() {
  const proxyFromFile = loadProxyFromProxyEnvFile();
  const proxyFromEnv = process.env.PROXY || process.env.proxy;
  const proxy = config.proxy || proxyFromFile || proxyFromEnv;

  if (proxy) {
    const agent = new ProxyAgent(proxy);
    setGlobalDispatcher(agent);
    console.log("Proxy enabled:", proxy);
  } else {
    console.log("Proxy not set (direct connection).");
  }
}

// ----------------------
// Fetch helper
// ----------------------
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function downloadText(url) {
  const res = await fetchWithTimeout(url, config.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function downloadJson(url) {
  const res = await fetchWithTimeout(url, config.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
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

// ----------------------
// Main
// ----------------------
async function main() {
  setupProxy();
  ensureDir(config.outputDir);

  const versionUrl = `${config.repoRawBase}/docs/version.json`;
  console.log("Checking:", versionUrl);

  const remoteVersion = await downloadJson(versionUrl);
  // expected:
  // { version: <number>, generated_at: "...", channels: ["..."] }

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
    console.log("No update. Version unchanged:", remoteVersion.version);
    return;
  }

  console.log(
    `Update found. Old: ${lastVersionNumber ?? "none"}  New: ${remoteVersion.version}`
  );
  console.log("Channels:", remoteVersion.channels.join(", "));

  // Download pages
  for (const ch of remoteVersion.channels) {
    const pageUrl = `${config.repoRawBase}/docs/${encodeURIComponent(ch)}.html`;
    const outPath = path.join(config.outputDir, `${ch}.html`);

    console.log("Downloading:", pageUrl);
    const html = await downloadText(pageUrl);

    fs.writeFileSync(outPath, html, "utf-8");
    console.log("Saved:", outPath);
  }

  // Save a copy of version.json too
  fs.writeFileSync(
    path.join(config.outputDir, "version.json"),
    JSON.stringify(remoteVersion, null, 2),
    "utf-8"
  );

  // Record last seen version
  writeLastVersion({
    version: remoteVersion.version,
    generated_at: remoteVersion.generated_at || null,
    checked_at: new Date().toISOString(),
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Downloader failed:", err);
  process.exit(1);
});
