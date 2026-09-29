const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Filter Baileys Noise & Key Ratchet Warning Logs
const isNoise = (args) => {
    const str = args.map(a => {
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
    }).join(' ');

    return (
        str.includes('MessageCounterError') ||
        str.includes('Failed to decrypt') ||
        str.includes('SessionEntry') ||
        errorIsSessionObject(args) ||
        str.includes('Closing session') ||
        str.includes('Closing open session') ||
        str.includes('Bad MAC') ||
        str.includes('Session error') ||
        str.includes('registrationId') ||
        str.includes('_chains') ||
        str.includes('currentRatchet')
    );
};

function errorIsSessionObject(args) {
    return args.some(arg => arg && typeof arg === 'object' && (arg.registrationId || arg.currentRatchet || arg._chains));
}

['log', 'error', 'info', 'warn'].forEach((method) => {
    const orig = console[method];
    console[method] = function (...args) {
        if (isNoise(args)) return;
        orig.apply(console, args);
    };
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// CONFIGURATION & DISK PERSISTENCE
const configPath = path.join(__dirname, 'config.json');
const viewedPath = path.join(__dirname, 'viewed_statuses.json');

function getConfig() {
    let defaultConfig = {
        AUTO_STATUS_VIEW: 'no-dl',
        ANTI_DELETE: 'p',
        NOTIFIED_STARTUP: false
    };

    if (fs.existsSync(configPath)) {
        try {
            const savedData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return { ...defaultConfig, ...savedData };
        } catch (e) {
            return defaultConfig;
        }
    } else {
        try {
            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        } catch (e) {}
        return defaultConfig;
    }
}

function updateConfig(newSettings) {
    const current = getConfig();
    const updated = { ...current, ...newSettings };
    try {
        fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
    } catch (e) {
        console.error('Failed to write config.json:', e);
    }
    return updated;
}

let viewedStatusSet = new Set();
if (fs.existsSync(viewedPath)) {
    try {
        const saved = JSON.parse(fs.readFileSync(viewedPath, 'utf-8'));
        viewedStatusSet = new Set(saved);
    } catch (e) {}
}

function markStatusAsViewedOnDisk(id) {
    if (!id) return;
    viewedStatusSet.add(id);

    if (viewedStatusSet.size > 3000) {
        const first = viewedStatusSet.values().next().value;
        viewedStatusSet.delete(first);
    }

    try {
        fs.writeFileSync(viewedPath, JSON.stringify(Array.from(viewedStatusSet)));
    } catch (e) {}
}

const messageStore = new Map();
const recentStatusStore = new Map();
const startTime = Date.now();
let activeSock = null;
let initialActiveLogged = false;
let sweeperInterval = null;

function trackStatusKey(msg) {
    if (!msg || !msg.key || !msg.key.id) return;
    recentStatusStore.set(msg.key.id, msg);

    if (recentStatusStore.size > 1000) {
        const firstKey = recentStatusStore.keys().next().value;
        recentStatusStore.delete(firstKey);
    }
}

// STATUS PROCESSING QUEUE
const statusQueue = [];
let isProcessingQueue = false;

async function processStatusQueue(sock) {
    const activeConfig = getConfig();
    if (activeConfig.AUTO_STATUS_VIEW === 'off') {
        statusQueue.length = 0;
        return;
    }

    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        while (statusQueue.length > 0) {
            const currentCfg = getConfig();
            if (currentCfg.AUTO_STATUS_VIEW === 'off') {
                statusQueue.length = 0;
                break;
            }

            const item = statusQueue.shift();
            if (!item || !item.msg || !item.msg.key) continue;

            const statusId = item.msg.key.id;
            const participant = item.msg.key.participant || item.msg.participant || item.msg.key.remoteJid;

            if (!item.force && viewedStatusSet.has(statusId)) continue;
            if (!participant || participant === 'status@broadcast') continue;

            const cleanKey = {
                remoteJid: 'status@broadcast',
                id: statusId,
                participant: participant,
                fromMe: false
            };

            try {
                if (sock.readMessages) {
                    await sock.readMessages([cleanKey]);
                }

                if (sock.sendReceipt) {
                    await sock.sendReceipt('status@broadcast', participant, [statusId], 'read').catch(() => null);
                    await sock.sendReceipt('status@broadcast', participant, [statusId], 'read-self').catch(() => null);
                }

                markStatusAsViewedOnDisk(statusId);
                console.log(`[STATUS MOVED TO VIEWED] ID: ${statusId} From: ${participant}`);
            } catch (err) {
                if (!viewedStatusSet.has(statusId)) {
                    setTimeout(() => {
                        statusQueue.push(item);
                        if (activeSock) processStatusQueue(activeSock);
                    }, 3000);
                }
            }

            const randomDelay = Math.floor(Math.random() * 250) + 200;
            await new Promise(res => setTimeout(res, randomDelay));
        }
    } finally {
        isProcessingQueue = false;
    }
}

async function sweepAndReadStatuses(sock) {
    const activeConfig = getConfig();
    if (activeConfig.AUTO_STATUS_VIEW === 'off') return 0;

    let count = 0;
    for (const [id, msg] of recentStatusStore.entries()) {
        if (!viewedStatusSet.has(id)) {
            statusQueue.push({ msg, force: false });
            count++;
        }
    }
    if (count > 0) processStatusQueue(sock);
    return count;
}

async function forceSweepAndReadStatuses(sock) {
    const activeConfig = getConfig();
    if (activeConfig.AUTO_STATUS_VIEW === 'off') return 0;

    let count = 0;
    for (const [id, msg] of recentStatusStore.entries()) {
        viewedStatusSet.delete(id);
        statusQueue.push({ msg, force: true });
        count++;
    }
    if (count > 0) processStatusQueue(sock);
    return count;
}

async function startBot() {
    const credsPath = path.join(__dirname, 'auth_info', 'creds.json');
    const isRegisteredOnDisk = fs.existsSync(credsPath);
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    let usePairingCode = false;
    let userPhoneNumber = '';
    const isInteractive = process.stdin.isTTY;

    if (!isRegisteredOnDisk && !state.creds.registered) {
        if (isInteractive) {
            console.log(`\n============================================`);
            console.log(`📱 CHOOSE WHATSAPP LINKING METHOD:`);
            console.log(`1) Scan QR Code (Terminal QR)`);
            console.log(`2) Use WhatsApp Pairing Code (8-digit code)`);
            console.log(`============================================\n`);

            const choice = await question('Select [1] for QR Code or [2] for Pairing Code:\n> ');

            if (choice.trim() === '2') {
                usePairingCode = true;
                const phoneNumber = await question('\n📱 Enter your WhatsApp phone number with country code (e.g. 254712345678):\n> ');
                userPhoneNumber = phoneNumber.replace(/[^0-9]/g, '');
            } else {
                console.log('\n⌛ Waiting for QR Code generation...');
            }
        }
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 5,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async (key) => {
            if (key.id && messageStore.has(key.id)) {
                return messageStore.get(key.id).message;
            }
            if (key.id && recentStatusStore.has(key.id)) {
                return recentStatusStore.get(key.id).message;
            }
            return { conversation: '' };
        }
    });

    if (usePairingCode && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(userPhoneNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\n============================================`);
                console.log(`🔑 YOUR WHATSAPP PAIRING CODE: ${formattedCode}`);
                console.log(`============================================\n`);
            } catch (err) {
                console.error('Failed to request pairing code:', err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode && isInteractive) {
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            if (activeSock) {
                try {
                    activeSock.ev.removeAllListeners();
                    if (activeSock.ws) activeSock.ws.close();
                } catch (e) {}
                activeSock = null;
            }

            if (!isLoggedOut) {
                setTimeout(() => startBot(), 2000);
            } else {
                console.log('⚠️ Session logged out. Run "npm start" to re-link account.');
            }
        } else if (connection === 'open') {
            activeSock = sock;

            if (!initialActiveLogged) {
                initialActiveLogged = true;
                console.log(`✅ Silent Status Bot Active! Designed by Josva.`);
            }

            if (getConfig().AUTO_STATUS_VIEW !== 'off') {
                sweepAndReadStatuses(sock);
            }
        }
    });

    if (sweeperInterval) {
        clearInterval(sweeperInterval);
        sweeperInterval = null;
    }

    sweeperInterval = setInterval(() => {
        const currentCfg = getConfig();
        if (currentCfg.AUTO_STATUS_VIEW !== 'off' && activeSock) {
            sweepAndReadStatuses(activeSock);
        }
    }, 5 * 60 * 1000);

    sock.ev.on('messages.upsert', async (m) => {
        const sudoJid = sock.user ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const fromJid = msg.key.remoteJid;
            const isGroup = fromJid.endsWith('@g.us');
            const type = getContentType(msg.message);
            const isFromSudo = msg.key.fromMe || (msg.key.participant && sudoJid && msg.key.participant.includes(sudoJid.split('@')[0]));

            // AUTO STATUS VIEWER
            if (msg.key && fromJid === 'status@broadcast' && !msg.key.fromMe) {
                trackStatusKey(msg);
                if (getConfig().AUTO_STATUS_VIEW !== 'off') {
                    statusQueue.push({ msg: msg, force: false });
                    processStatusQueue(sock);
                }
                continue;
            }

            // CACHE MESSAGES
            if (msg.key.id && fromJid !== 'status@broadcast') {
                messageStore.set(msg.key.id, {
                    key: msg.key,
                    message: msg.message,
                    participant: msg.key.participant || fromJid
                });

                if (messageStore.size > 500) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            // COMMAND PARSER
            const textContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!textContent.startsWith('.')) continue;

            const args = textContent.trim().split(' ');
            const command = args[0].toLowerCase();
            const param = args[1] ? args[1].toLowerCase() : '';
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

            if (['.alive', '.ping'].includes(command)) {
                const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptimeSec / 3600);
                const minutes = Math.floor((uptimeSec % 3600) / 60);
                const seconds = uptimeSec % 60;

                const aliveMsg = `I'm here and ready! 🚀\nUptime : ${hours} hours ${minutes} minutes ${seconds} seconds`;
                await sock.sendMessage(fromJid, { text: aliveMsg });
                continue;
            }

            if (isFromSudo) {
                if (['.menu', '.settings', '.vars', '.help'].includes(command)) {
                    const currentCfg = getConfig();
                    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptimeSec / 3600);
                    const minutes = Math.floor((uptimeSec % 3600) / 60);
                    const ramUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

                    const menuText = `⚙️ *BOT SETTINGS & STATUS*\n\n` +
                                     `🛡️ *SUDO:* +${sudoJid ? sudoJid.split('@')[0] : 'Owner'}\n` +
                                     `👀 *AUTO STATUS VIEW:* ${currentCfg.AUTO_STATUS_VIEW !== 'off' ? '✅ (' + currentCfg.AUTO_STATUS_VIEW + ')' : '❎ (off)'}\n` +
                                     `🗑️ *ANTI DELETE MSG:* ${currentCfg.ANTI_DELETE !== 'off' ? '✅ (' + currentCfg.ANTI_DELETE + ')' : '❎ (off)'}\n` +
                                     `💾 *RAM USAGE:* ${ramUsage} MB\n` +
                                     `⏱️ *UPTIME:* ${hours}h ${minutes}m\n\n` +
                                     `*Commands:* .alive, .react, .forceview, .sticker, .viewall, .status, .delete, .vv, .save`.trim();

                    // Send directly without quoting to prevent self-message signal ratchet drops
                    await sock.sendMessage(fromJid, { text: menuText });
                    continue;
                }
            }
        }
    });
}

startBot();
