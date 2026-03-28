const fs = require("fs");
const CryptoJS = require("crypto-js");
const { setGlobalDispatcher, ProxyAgent } = require("undici");
const env = require("./env");
const page = require("./page-ugly");

// ===== Proxy (optional) =====
if (env.proxy) {
    const proxyAgent = new ProxyAgent(env.proxy);
    setGlobalDispatcher(proxyAgent);
}

// ===== Output folder =====
const OUTPUT_DIR = "./docs";
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// ===== Logging =====
function timestamp() {
    return new Date().toLocaleString();
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

    const mac = CryptoJS.HmacSHA256(
        salt.clone().concat(iv).concat(cipher),
        macKey
    );

    const packed = salt.clone().concat(iv).concat(cipher).concat(mac);

    return "v1." + b64url(packed);
}

// ===== Main build =====
async function build() {
    try {
        console.log("Starting build...");

        for (const channel of env.telegramChannels) {
            console.log(`Fetching ${channel}...`);

            const response = await fetch(
                `https://samitel.vercel.app/api/channel?username=${channel}`
            );

            const json = await response.json();

            let messagesText =
                `پیام‌ها از جدید به قدیمی مرتب شده اند.\n` +
                `زمان آخرین جمع‌آوری: ${timestamp()}\n\n` +
                `========= ${channel} =========`;

            for (const msg of json.messages) {
                if (!msg.text) continue;

                messagesText += `\n\n---------------------------------------`;
                messagesText += `\n[${new Date(msg.date).toLocaleString()}]\n${msg.text}`;
            }

            const encrypted = encryptToToken(
                messagesText,
                env.encryptionKey
            );

            const html = page.replace("#ENCODEDHERE#", encrypted);

            const filePath = `${OUTPUT_DIR}/${channel}.html`;

            fs.writeFileSync(filePath, html);

            console.log(`${channel} saved`);
        }

        console.log("Build completed");

    } catch (err) {
        console.error("Build failed:", err);
        process.exit(1); // important for GitHub Actions
    }
}

// ===== Run once =====
build();