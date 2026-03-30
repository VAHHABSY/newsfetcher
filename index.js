const fs = require("fs");
const path = require("path");
const CryptoJS = require("crypto-js");
const { setGlobalDispatcher, ProxyAgent } = require("undici");
const env = require("./env");

// ===== Fetch fallback (safety for Node envs) =====
const fetch = global.fetch || require("node-fetch");

// ===== Proxy (optional) =====
// Keep it in env.js as: proxy: "http://user:pass@host:port"  OR  "socks5://host:port" (if your undici supports it)
if (env.proxy) {
    const proxyAgent = new ProxyAgent(env.proxy);
    setGlobalDispatcher(proxyAgent);
}

// ===== Output folder =====
const OUTPUT_DIR = path.join(__dirname, "docs");
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// ===== Timezone formatter =====
const TIMEZONE = "Asia/Tehran";

function formatDate(date) {
    return new Date(date).toLocaleString("fa-IR", {
        timeZone: TIMEZONE,
    });
}

// ===== Logging =====
function timestamp() {
    return formatDate(new Date());
}

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    originalLog(`[${timestamp()}]`, ...args);
};

console.error = (...args) => {
    originalError(`[${timestamp()}]`, ...args);
};

// ===== Crypto helpers =====
function b64url(wordArray) {
    return CryptoJS.enc.Base64.stringify(wordArray)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function encryptToToken(text, password) {
    const salt = CryptoJS.lib.WordArray.random(16);
    const iv = CryptoJS.lib.WordArray.random(16);

    const key = CryptoJS.PBKDF2(password, salt, {
        keySize: 512 / 32,
        iterations: 100000,
    });

    const aesKey = CryptoJS.lib.WordArray.create(key.words.slice(0, 8));
    const macKey = CryptoJS.lib.WordArray.create(key.words.slice(8, 16));

    const enc = CryptoJS.AES.encrypt(text, aesKey, { iv });
    const cipher = enc.ciphertext;

    const mac = CryptoJS.HmacSHA256(salt.clone().concat(iv).concat(cipher), macKey);

    const packed = salt.clone().concat(iv).concat(cipher).concat(mac);

    return "v1." + b64url(packed);
}

// ===== Load HTML template (beautified page) =====
function loadTemplate() {
    const templatePath = path.join(__dirname, "page-beautiful.html");
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template file not found: ${templatePath}`);
    }

    const html = fs.readFileSync(templatePath, "utf-8");

    if (!html.includes("#ENCODEDHERE#")) {
        throw new Error(
            `Template does not contain the placeholder "#ENCODEDHERE#": ${templatePath}`
        );
    }

    return html;
}

// ===== Version + Manifest writers =====
function writeVersionAndManifest({ version, channels }) {
    const versionObj = {
        version, // number (Date.now())
        generated_at: new Date().toISOString(),
        channels,
    };

    fs.writeFileSync(
        path.join(OUTPUT_DIR, "version.json"),
        JSON.stringify(versionObj, null, 2),
        "utf-8"
    );

    const manifest = {
        version,
        generated_at: versionObj.generated_at,
        files: channels.map((ch) => ({
            channel: ch,
            file: `${ch}.html`,
            path: `docs/${ch}.html`,
        })),
    };

    fs.writeFileSync(
        path.join(OUTPUT_DIR, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf-8"
    );

    console.log("version.json + manifest.json saved");
}

// ===== Main build =====
async function build() {
    try {
        console.log("Starting build...");

        const template = loadTemplate();
        const MAX_MESSAGES = 50;

        // monotonic build version for your auto-downloader
        const version = Date.now();

        for (const channel of env.telegramChannels) {
            console.log(`Fetching ${channel}...`);

            const response = await fetch(
                `https://samitel.vercel.app/api/channel?username=${channel}`
            );

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${channel}`);
            }

            const json = await response.json();

            if (!json.messages) {
                throw new Error(`Invalid response for ${channel}`);
            }

            let messagesText =
                `پیام‌ها از جدید به قدیمی مرتب شده اند.\n` +
                `زمان آخرین جمع‌آوری: ${timestamp()}\n\n` +
                `========= ${channel} =========`;

            for (const msg of json.messages.slice(0, MAX_MESSAGES)) {
                if (!msg.text || typeof msg.text !== "string") continue;

                // handle seconds vs milliseconds timestamps safely
                const dateValue = msg.date < 1e12 ? msg.date * 1000 : msg.date;

                messagesText += `\n\n---------------------------------------`;
                messagesText += `\n[${formatDate(dateValue)}]\n${msg.text}`;
            }

            const encrypted = encryptToToken(messagesText, env.encryptionKey);

            const html = template.replace("#ENCODEDHERE#", encrypted);
            const filePath = path.join(OUTPUT_DIR, `${channel}.html`);

            fs.writeFileSync(filePath, html, "utf-8");

            console.log(`${channel} saved`);
        }

        // write version info AFTER all pages are generated
        writeVersionAndManifest({
            version,
            channels: env.telegramChannels,
        });

        console.log("Build completed");
    } catch (err) {
        console.error("Build failed:", err);
        process.exit(1);
    }
}

// ===== Run once =====
build();
