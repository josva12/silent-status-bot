const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Suppress harmless libsignal session noise from logs
const originalConsoleError = console.error;
console.error = function (...args) {
    const errorStr = args.join(' ');
    if (
        errorStr.includes('MessageCounterError') ||
        errorStr.includes('Failed to decrypt') ||
        errorStr.includes('SessionEntry') ||
        errorStr.includes('Closing session')
    ) {
        return;
    }
    originalConsoleError.apply(console, args);
};

// =========================================================
// PERSISTENT CONFIGURATION
// =========================================================
const configPath = path.join(__dirname, 'config.json');

let config = {
    AUTO_STATUS_VIEW: 'no-dl', // 'no-dl' or 'off'
    ANTI_DELETE: 'p'           // 'p', 'g', or 'off'
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

const messageStore = new Map();
const recentStatusStore = new Map();
const startTime = Date.now();
let hasNotifiedStartup = false;

// Track status keys for .viewall and background sweeper
function trackStatusKey(key) {
    if (!key || !key.id) return;
    recentStatusStore.set(key.id, key);

    if (recentStatusStore.size > 1000) {
        const firstKey = recentStatusStore.keys().next().value;
        recentStatusStore.delete(firstKey);
    }
}

// =========================================================
// STATUS QUEUE (50ms Micro-Delay)
// =========================================================
const statusQueue = [];
let isProcessingQueue = false;

async function processStatusQueue(sock) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (statusQueue.length > 0) {
        const item = statusQueue.shift();
        if (!item || !item.key) continue;

        try {
            await sock.readMessages([item.key]);
            console.log(`[STATUS VIEWED] ID: ${item.key.id} From: ${item.key.participant}`);
        } catch (err) {}

        await new Promise(res => setTimeout(res, 50));
    }

    isProcessingQueue = false;
}

async function sweepAndReadStatuses(sock) {
    let count = 0;
    for (const [id, key] of recentStatusStore.entries()) {
        statusQueue.push({ key });
        count++;
    }
    if (count > 0) {
        processStatusQueue(sock);
    }
    return count;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        generateHighQualityLinkPreview: false,
        shouldSyncHistoryMessage: () => false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            hasNotifiedStartup = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log(`✅ Silent Status Bot Active! Designed by Josva.`);

            // Send Startup Notification to SUDO DM
            if (!hasNotifiedStartup) {
                hasNotifiedStartup = true;
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
                                               `• *.status no-dl* | *.status off* - Toggle Status Auto-View\n` +
                                               `• *.delete p* | *.delete g* | *.delete off* - Toggle Anti-Delete\n` +
                                               `• *.viewall* - Manually sweep & re-view all status updates\n` +
                                               `• *.vv* - Reply to View-Once media to unlock silently\n` +
                                               `• *.save* - Reply to any message/media to save to DM\n` +
                                               `• *.settings* - View live bot dashboard & RAM usage`;

                            await sock.sendMessage(sudoJid, { text: notifyText });
                        }
                    } catch (e) {}
                }, 3000);
            }
        }
    });

    // 5-Minute Auto-Sweeper Timer
    setInterval(() => {
        if (config.AUTO_STATUS_VIEW !== 'off') {
            sweepAndReadStatuses(sock);
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
                trackStatusKey(msg.key);

                if (config.AUTO_STATUS_VIEW !== 'off') {
                    statusQueue.push({ key: msg.key });
                    processStatusQueue(sock);
                }
                continue;
            }

            // Cache incoming chat messages for Anti-Delete (Max 300 entries)
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

            // DYNAMIC IN-CHAT COMMANDS (SUDO / OWNER ONLY)
            if (isFromSudo) {
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
                                     `*Commands:* .viewall, .status, .delete, .vv, .save`.trim();

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
