const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Universal Noise Filter for PM2 Logs
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

// =========================================================
// PERSISTENT CONFIGURATION & VIEWED STATUS TRACKER
// =========================================================
const configPath = path.join(__dirname, 'config.json');
const viewedPath = path.join(__dirname, 'viewed_statuses.json');

let config = {
    AUTO_STATUS_VIEW: 'no-dl', // 'no-dl' or 'off'
    ANTI_DELETE: 'p',          // 'p', 'g', or 'off'
    NOTIFIED_STARTUP: false    // Sent once on Day 1, saved to disk
};

if (fs.existsSync(configPath)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
    } catch (e) {}
} else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {}
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

// =========================================================
// PACED STATUS QUEUE (Rate-limited, with retry on failure)
// =========================================================
const statusQueue = [];
let isProcessingQueue = false;

async function processStatusQueue(sock) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        while (statusQueue.length > 0) {
            const item = statusQueue.shift();
            if (!item || !item.msg || !item.msg.key) continue;

            const statusId = item.msg.key.id;
            const participant = item.msg.key.participant || item.msg.participant || item.msg.key.remoteJid;

            if (!item.force && viewedStatusSet.has(statusId)) continue;

            // Skip malformed entries with no valid participant
            if (!participant || participant === 'status@broadcast') continue;

            const cleanKey = {
                remoteJid: 'status@broadcast',
                id: statusId,
                participant: participant,
                fromMe: false
            };

            try {
                // 1. High-level readMessages call using the message key
                if (sock.readMessages) {
                    await sock.readMessages([item.msg.key || cleanKey]).catch(() => null);
                }

                // 2. Direct 'read' receipt stanza to status sender
                if (sock.sendReceipt) {
                    await sock.sendReceipt('status@broadcast', participant, [statusId], 'read').catch(() => null);
                }

                await new Promise(res => setTimeout(res, 200));

                // 3. Direct 'read-self' receipt stanza for Multi-Device phone sync
                if (sock.sendReceipt) {
                    await sock.sendReceipt('status@broadcast', participant, [statusId], 'read-self').catch(() => null);
                }

                // 4. AppState Sync patch to move status updates to Viewed Updates in phone UI
                if (sock.chatModify && item.msg) {
                    await sock.chatModify(
                        { markRead: true, lastMessages: [item.msg] },
                        'status@broadcast'
                    ).catch(() => null);
                }

                markStatusAsViewedOnDisk(statusId);
                console.log(`[STATUS VIEWED & SYNCED] ID: ${statusId} From: ${participant}`);
            } catch (err) {
                if (!viewedStatusSet.has(statusId)) {
                    setTimeout(() => {
                        statusQueue.push(item);
                        if (activeSock) processStatusQueue(activeSock);
                    }, 3000);
                }
            }

            // Paced 1000ms delay per status item to avoid rate-limiting
            await new Promise(res => setTimeout(res, 1000));
        }
    } finally {
        isProcessingQueue = false;
    }
}

async function sweepAndReadStatuses(sock) {
    let count = 0;
    for (const [id, msg] of recentStatusStore.entries()) {
        if (!viewedStatusSet.has(id)) {
            statusQueue.push({ msg, force: false });
            count++;
        }
    }
    if (count > 0) {
        processStatusQueue(sock);
    }
    return count;
}

async function forceSweepAndReadStatuses(sock) {
    let count = 0;
    for (const [id, msg] of recentStatusStore.entries()) {
        viewedStatusSet.delete(id);
        statusQueue.push({ msg, force: true });
        count++;
    }
    if (count > 0) {
        processStatusQueue(sock);
    }
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
        } else {
            console.log('\n⚠️ No session credentials found in auth_info! Run "npm start" in terminal once to link your account.');
        }
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000,
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
                console.log(`🔑 YOUR WHATSAPP PAIRING CODE:`);
                console.log(`\n       👉   ${formattedCode}   👈\n`);
                console.log(`1. Open WhatsApp on your phone.`);
                console.log(`2. Tap Settings -> Linked Devices -> Link a Device.`);
                console.log(`3. Tap 'Link with phone number instead' & enter the code above.`);
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

            sweepAndReadStatuses(sock);

            if (!config.NOTIFIED_STARTUP) {
                config.NOTIFIED_STARTUP = true;
                saveConfig();

                setTimeout(async () => {
                    try {
                        const sudoJid = sock.user ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
                        if (sudoJid) {
                            const notifyText = `🚀 *SILENT STATUS BOT IS ONLINE*\n` +
                                               `_Designed by Josva_\n\n` +
                                               `⚙️ *ACTIVE SETTINGS:*\n` +
                                               `• Status View: *${config.AUTO_STATUS_VIEW}*\n` +
                                               `• Anti-Delete: *${config.ANTI_DELETE}*\n\n` +
                                               `💬 *IN-CHAT COMMANDS:*\n` +
                                               `• *.alive* - Check bot uptime status\n` +
                                               `• *.forceview* - Force re-view & resync all status updates\n` +
                                               `• *.sticker* | *.s* - Reply to photo/video to make sticker\n` +
                                               `• *.status no-dl* | *.status off* - Toggle Status Auto-View\n` +
                                               `• *.delete p* | *.delete g* | *.delete off* - Toggle Anti-Delete\n` +
                                               `• *.viewall* - Manually sweep & re-view status updates\n` +
                                               `• *.vv* - Reply to View-Once media to unlock silently\n` +
                                               `• *.save* - Reply to any message/media to save to DM\n` +
                                               `• *.settings* - View live dashboard & RAM usage`;

                            await sock.sendMessage(sudoJid, { text: notifyText });
                        }
                    } catch (e) {}
                }, 3000);
            }
        }
    });

    // Clear old timer on reconnect to prevent interval leaks
    if (sweeperInterval) {
        clearInterval(sweeperInterval);
        sweeperInterval = null;
    }

    // 5-Minute Auto-Sweeper Timer
    sweeperInterval = setInterval(() => {
        if (config.AUTO_STATUS_VIEW !== 'off' && activeSock) {
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

            // 1. SILENT AUTO STATUS VIEWER
            if (msg.key && fromJid === 'status@broadcast' && !msg.key.fromMe) {
                trackStatusKey(msg);

                if (config.AUTO_STATUS_VIEW !== 'off') {
                    statusQueue.push({ msg: msg, force: false });
                    processStatusQueue(sock);
                }
                continue;
            }

            // Cache incoming chat messages for Anti-Delete
            if (msg.key.id && fromJid !== 'status@broadcast') {
                messageStore.set(msg.key.id, {
                    key: msg.key,
                    message: msg.message,
                    participant: msg.key.participant || fromJid
                });

                if (messageStore.size > 300) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            // 2. ANTI-DELETE LISTENER
            if (type === 'protocolMessage' && msg.message.protocolMessage?.type === 0 && config.ANTI_DELETE !== 'off') {
                const deletedKey = msg.message.protocolMessage.key;
                const deletedMsg = messageStore.get(deletedKey.id);

                if (deletedMsg) {
                    try {
                        const targetChat = config.ANTI_DELETE === 'g' ? fromJid : sudoJid;
                        const sender = deletedMsg.participant.split('@')[0];
                        const header = `🗑️ *Anti-Delete Alert*\n👤 *Sender:* @${sender}\n💬 *Chat:* ${isGroup ? 'Group' : 'Private'}\n\n`;

                        const innerType = getContentType(deletedMsg.message);

                        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(innerType)) {
                            const mediaBuffer = await downloadMediaMessage({ key: deletedMsg.key, message: deletedMsg.message }, 'buffer', {}, { logger: pino({ level: 'silent' }) }).catch(() => null);
                            if (mediaBuffer) {
                                const mediaPayload = { caption: `${header}*Deleted Media*`, mentions: [deletedMsg.participant] };
                                if (innerType === 'imageMessage') mediaPayload.image = mediaBuffer;
                                else if (innerType === 'videoMessage') mediaPayload.video = mediaBuffer;
                                else if (innerType === 'audioMessage') mediaPayload.audio = mediaBuffer;
                                else if (innerType === 'stickerMessage') mediaPayload.sticker = mediaBuffer;
                                else mediaPayload.document = mediaBuffer;

                                await sock.sendMessage(targetChat, mediaPayload, { quoted: msg });
                            }
                        } else {
                            const deletedText = deletedMsg.message?.conversation || deletedMsg.message?.extendedTextMessage?.text || 'Message content';
                            await sock.sendMessage(targetChat, { text: `${header}*Deleted Message:* ${deletedText}`, mentions: [deletedMsg.participant] }, { quoted: msg });
                        }
                        console.log(`[ANTI-DELETE TRIGGERED] Restored deleted message from ${sender}`);
                    } catch (err) {}
                }
            }

            // COMMAND PARSER
            const textContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!textContent.startsWith('.')) continue;

            const args = textContent.trim().split(' ');
            const command = args[0].toLowerCase();
            const param = args[1] ? args[1].toLowerCase() : '';
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

            // COMMAND: .alive / .ping
            if (['.alive', '.ping'].includes(command)) {
                const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptimeSec / 3600);
                const minutes = Math.floor((uptimeSec % 3600) / 60);
                const seconds = uptimeSec % 60;

                const aliveMsg = `I'm here and ready! 🚀\nUptime : ${hours} hours ${minutes} minutes ${seconds} seconds`;
                await sock.sendMessage(fromJid, { text: aliveMsg }, { quoted: msg });
                continue;
            }

            // COMMAND: .sticker / .s (Photo/Video to Sticker Maker)
            if (['.sticker', '.s', '.stk'].includes(command)) {
                const targetMedia = quotedMsg || msg.message;
                const mediaType = quotedMsg ? getContentType(quotedMsg) : type;

                if (['imageMessage', 'videoMessage'].includes(mediaType)) {
                    try {
                        const targetMsgObj = quotedMsg ? {
                            key: { remoteJid: fromJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                            message: quotedMsg
                        } : msg;

                        const mediaBuffer = await downloadMediaMessage(targetMsgObj, 'buffer', {}, { logger: pino({ level: 'silent' }) }).catch(() => null);

                        if (mediaBuffer) {
                            const { Sticker, StickerTypes } = require('wa-sticker-formatter');
                            const sticker = new Sticker(mediaBuffer, {
                                pack: 'Silent Status Bot',
                                author: 'Josva',
                                type: StickerTypes.FULL,
                                quality: 70
                            });

                            const stickerBuffer = await sticker.toBuffer();
                            await sock.sendMessage(fromJid, { sticker: stickerBuffer }, { quoted: msg });
                            console.log(`[.sticker COMMAND] Sticker created successfully`);
                        }
                    } catch (err) {
                        console.error('.sticker command error:', err);
                    }
                }
                continue;
            }

            // DYNAMIC IN-CHAT COMMANDS (SUDO / OWNER ONLY)
            if (isFromSudo) {
                if (['.forceview', '.resync', '.review'].includes(command)) {
                    const count = await forceSweepAndReadStatuses(sock);
                    await sock.sendMessage(fromJid, { text: `Done! Force-reviewed and resynced ${count} status updates. 🚀` }, { quoted: msg });
                    continue;
                }

                if (command === '.viewall' || command === '.readstatus') {
                    const count = await sweepAndReadStatuses(sock);
                    await sock.sendMessage(fromJid, { text: `Done! Swept and re-viewed ${count} status updates. ✅` }, { quoted: msg });
                    continue;
                }

                if (command === '.status') {
                    if (['no-dl', 'on', 'true'].includes(param)) {
                        config.AUTO_STATUS_VIEW = 'no-dl';
                        saveConfig();
                        await sock.sendMessage(fromJid, { text: 'Done! Status View: [no-dl] ✅' }, { quoted: msg });
                    } else if (['off', 'false'].includes(param)) {
                        config.AUTO_STATUS_VIEW = 'off';
                        saveConfig();
                        await sock.sendMessage(fromJid, { text: 'Done! Status View: [off] 🛑' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(fromJid, { text: `Current Setting: Status View = [${config.AUTO_STATUS_VIEW}]\nUsage: .status no-dl | .status off` }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.delete') {
                    if (param === 'p') {
                        config.ANTI_DELETE = 'p';
                        saveConfig();
                        await sock.sendMessage(fromJid, { text: 'Done! Anti-Delete: [p] (Send to SUDO DM) 🗑️' }, { quoted: msg });
                    } else if (param === 'g') {
                        config.ANTI_DELETE = 'g';
                        saveConfig();
                        await sock.sendMessage(fromJid, { text: 'Done! Anti-Delete: [g] (Send to Same Group) 🗑️' }, { quoted: msg });
                    } else if (['off', 'false'].includes(param)) {
                        config.ANTI_DELETE = 'off';
                        saveConfig();
                        await sock.sendMessage(fromJid, { text: 'Done! Anti-Delete: [off] 🛑' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(fromJid, { text: `Current Setting: Anti-Delete = [${config.ANTI_DELETE}]\nUsage: .delete p | .delete g | .delete off` }, { quoted: msg });
                    }
                    continue;
                }

                if (['.menu', '.settings', '.vars', '.help'].includes(command)) {
                    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptimeSec / 3600);
                    const minutes = Math.floor((uptimeSec % 3600) / 60);
                    const ramUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

                    const menuText = `⚙️ *BOT SETTINGS & STATUS*\n\n` +
                                     `🛡️ *SUDO:* +${sudoJid ? sudoJid.split('@')[0] : 'Owner'}\n` +
                                     `👀 *AUTO STATUS VIEW:* ${config.AUTO_STATUS_VIEW !== 'off' ? '✅ (' + config.AUTO_STATUS_VIEW + ')' : '❎ (off)'}\n` +
                                     `🗑️ *ANTI DELETE MSG:* ${config.ANTI_DELETE !== 'off' ? '✅ (' + config.ANTI_DELETE + ')' : '❎ (off)'}\n` +
                                     `💾 *RAM USAGE:* ${ramUsage} MB\n` +
                                     `⏱️ *UPTIME:* ${hours}h ${minutes}m\n\n` +
                                     `*Commands:* .alive, .forceview, .sticker, .viewall, .status, .delete, .vv, .save`.trim();

                    await sock.sendMessage(fromJid, { text: menuText }, { quoted: msg });
                    continue;
                }
            }

            // USER COMMANDS (.vv and .save)
            if (command === '.vv') {
                if (!quotedMsg) continue;

                const voObj = quotedMsg.viewOnceMessage?.message || quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessageV2Extension?.message || quotedMsg;
                const voType = getContentType(voObj);

                if (['imageMessage', 'videoMessage', 'audioMessage'].includes(voType)) {
                    try {
                        const fakeMsg = {
                            key: { remoteJid: fromJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                            message: voObj
                        };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                        if (buffer) {
                            const payload = {};
                            if (voType === 'imageMessage') payload.image = buffer;
                            else if (voType === 'videoMessage') payload.video = buffer;
                            else if (voType === 'audioMessage') payload.audio = buffer;

                            await sock.sendMessage(fromJid, payload, { quoted: msg });
                            console.log(`[.vv COMMAND] View-Once media unlocked silently`);
                        }
                    } catch (err) {}
                }
            }

            if (command === '.save') {
                if (!quotedMsg) continue;

                try {
                    const saveType = getContentType(quotedMsg);

                    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(saveType)) {
                        const fakeMsg = {
                            key: { remoteJid: fromJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                            message: quotedMsg
                        };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) }).catch(() => null);

                        if (buffer && sudoJid) {
                            const payload = {};
                            if (saveType === 'imageMessage') payload.image = buffer;
                            else if (saveType === 'videoMessage') payload.video = buffer;
                            else if (saveType === 'audioMessage') payload.audio = buffer;
                            else if (saveType === 'stickerMessage') payload.sticker = buffer;
                            else payload.document = buffer;

                            await sock.sendMessage(sudoJid, payload);
                            console.log(`[.save COMMAND] Content saved silently to SUDO DM`);
                        }
                    } else {
                        const saveText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || 'Text message';
                        if (sudoJid) {
                            await sock.sendMessage(sudoJid, { text: saveText });
                            console.log(`[.save COMMAND] Text saved silently to SUDO DM`);
                        }
                    }
                } catch (err) {}
            }
        }
    });
}

startBot();
