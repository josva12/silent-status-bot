const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage, 
    getContentType, 
    jidNormalizedUser,
    areJidsSameUser
} = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// =========================================================
// UNIVERSAL NOISE & CRYPTO ERROR INTERCEPTOR
// =========================================================
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
        str.includes('Closing session') ||
        str.includes('Closing open session') ||
        str.includes('Bad MAC') ||
        str.includes('Session error') ||
        str.includes('registrationId') ||
        str.includes('_chains') ||
        str.includes('currentRatchet')
    );
};

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
// PERSISTENT CONFIGURATION
// =========================================================
const configPath = path.join(__dirname, 'config.json');
const viewedPath = path.join(__dirname, 'viewed_statuses.json');

function getConfig() {
    let defaultConfig = {
        AUTO_STATUS_VIEW: 'no-dl', // 'no-dl' or 'off'
        ANTI_DELETE: 'p',          // 'p', 'g', or 'off'
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

// Helper: Recursively unwrap nested message envelopes
function unwrapMessage(msg) {
    if (!msg) return null;
    let m = msg;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    return m;
}

function trackStatusKey(msg) {
    if (!msg || !msg.key || !msg.key.id) return;
    recentStatusStore.set(msg.key.id, msg);

    if (recentStatusStore.size > 1000) {
        const firstKey = recentStatusStore.keys().next().value;
        recentStatusStore.delete(firstKey);
    }
}

function extractParticipantJids(msg) {
    const jids = new Set();
    if (msg && msg.key) {
        if (msg.key.participant) jids.add(msg.key.participant);
        if (msg.key.participantAlt) jids.add(msg.key.participantAlt);
        if (msg.key.remoteJid && msg.key.remoteJid !== 'status@broadcast') jids.add(msg.key.remoteJid);
    }
    if (msg && msg.participant) jids.add(msg.participant);
    return Array.from(jids).filter(Boolean);
}

// =========================================================
// PACED STATUS QUEUE
// =========================================================
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
            if (!item.force && viewedStatusSet.has(statusId)) continue;

            const participantJids = extractParticipantJids(item.msg);
            if (participantJids.length === 0) participantJids.push(item.msg.key.remoteJid);

            for (const pJid of participantJids) {
                const cleanKey = {
                    remoteJid: 'status@broadcast',
                    id: statusId,
                    participant: pJid,
                    fromMe: false
                };

                try {
                    await sock.readMessages([cleanKey]);

                    if (sock.sendReceipt) {
                        await sock.sendReceipt('status@broadcast', pJid, [statusId], 'read').catch(() => null);
                        await new Promise(res => setTimeout(res, 200));
                        await sock.sendReceipt('status@broadcast', pJid, [statusId], 'read-self').catch(() => null);
                    }
                } catch (err) {}
            }

            markStatusAsViewedOnDisk(statusId);
            console.log(`[STATUS VIEWED & SYNCED] ID: ${statusId} From: ${participantJids[0]}`);

            await new Promise(res => setTimeout(res, 600));
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
    if (count > 0) {
        processStatusQueue(sock);
    }
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
    if (count > 0) {
        processStatusQueue(sock);
    }
    return count;
}

// =========================================================
// APPLICATION ENTRY & SOCKET INITIALIZATION
// =========================================================
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
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000,
        markOnlineOnConnect: false,
        // SOLVES "Waiting for this message": Supplies WhatsApp with cached messages across multi-device companion syncs
        getMessage: async (key) => {
            if (key.id) {
                if (messageStore.has(key.id)) {
                    return messageStore.get(key.id).message;
                }
                if (recentStatusStore.has(key.id)) {
                    return recentStatusStore.get(key.id).message;
                }
            }
            return undefined;
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

            if (sock.resyncAppState) {
                await sock.resyncAppState(['regular', 'regular_high']).catch(() => null);
            }

            if (getConfig().AUTO_STATUS_VIEW !== 'off') {
                sweepAndReadStatuses(sock);
            }

            if (!getConfig().NOTIFIED_STARTUP) {
                updateConfig({ NOTIFIED_STARTUP: true });

                setTimeout(async () => {
                    try {
                        const sudoJid = sock.user ? jidNormalizedUser(sock.user.id) : null;
                        if (sudoJid) {
                            const currentCfg = getConfig();
                            const notifyText = `🚀 *SILENT STATUS BOT IS ONLINE*\n` +
                                               `_Designed by Josva_\n\n` +
                                               `⚙️ *ACTIVE SETTINGS:*\n` +
                                               `• Status View: *${currentCfg.AUTO_STATUS_VIEW}*\n` +
                                               `• Anti-Delete: *${currentCfg.ANTI_DELETE}*\n\n` +
                                               `💬 *IN-CHAT COMMANDS:*\n` +
                                               `• *.alive* - Check bot uptime status\n` +
                                               `• *.react <emoji>* | *.r* - Reply to any message to react with emoji\n` +
                                               `• *.forceview* - Force re-view & resync all status updates\n` +
                                               `• *.sticker* | *.s* - Reply to photo/video to make sticker\n` +
                                               `• *.status no-dl* | *.status off* - Toggle Status Auto-View\n` +
                                               `• *.delete p* | *.delete g* | *.delete off* - Toggle Anti-Delete\n` +
                                               `• *.viewall* - Manually sweep & re-view status updates\n` +
                                               `• *.vv* - Reply to View-Once media to unlock silently to SUDO DM\n` +
                                               `• *.save* - Reply to any message/media to save to SUDO DM\n` +
                                               `• *.settings* - View live dashboard & RAM usage`;

                            await sock.sendMessage(sudoJid, { text: notifyText });
                        }
                    } catch (e) {}
                }, 3000);
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

    // =========================================================
    // INCOMING MESSAGE & PROTOCOL DISPATCHER
    // =========================================================
    sock.ev.on('messages.upsert', async (m) => {
        const botUserJid = sock.user ? jidNormalizedUser(sock.user.id) : null;
        const botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const fromJid = msg.key.remoteJid;
            const isGroup = fromJid.endsWith('@g.us');
            const type = getContentType(msg.message);

            // Multi-Device SUDO Identification (matches phone, web, desktop, and companion instances)
            const senderJid = msg.key.participant ? jidNormalizedUser(msg.key.participant) : jidNormalizedUser(fromJid);
            const isFromSudo = msg.key.fromMe || 
                               (botUserJid && areJidsSameUser(senderJid, botUserJid)) || 
                               (botLid && areJidsSameUser(senderJid, botLid));

            // 1. AUTO STATUS VIEWER
            if (msg.key && fromJid === 'status@broadcast' && !msg.key.fromMe) {
                trackStatusKey(msg);

                const currentCfg = getConfig();
                if (currentCfg.AUTO_STATUS_VIEW !== 'off') {
                    statusQueue.push({ msg: msg, force: false });
                    processStatusQueue(sock);
                }
                continue;
            }

            // 2. CACHE ALL CHAT MESSAGES (Solves "Waiting for this message" & Powers Anti-Delete)
            if (msg.key.id && fromJid !== 'status@broadcast') {
                messageStore.set(msg.key.id, {
                    key: msg.key,
                    message: msg.message,
                    participant: msg.key.participant || fromJid,
                    remoteJid: fromJid,
                    timestamp: msg.messageTimestamp
                });

                if (messageStore.size > 2000) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            // 3. ANTI-DELETE PROTOCOL LISTENER
            const activeAntiDelete = getConfig().ANTI_DELETE;
            if (type === 'protocolMessage' && msg.message.protocolMessage?.type === 0 && activeAntiDelete !== 'off') {
                const deletedKey = msg.message.protocolMessage.key;
                const deletedMsg = messageStore.get(deletedKey.id);

                if (deletedMsg && botUserJid) {
                    try {
                        const targetChat = activeAntiDelete === 'g' ? fromJid : botUserJid;
                        const senderNumber = (deletedMsg.participant || fromJid).split('@')[0];
                        const header = `🗑️ *Anti-Delete Alert*\n👤 *Sender:* @${senderNumber}\n💬 *Chat:* ${isGroup ? 'Group' : 'Private'}\n\n`;

                        const unwrapped = unwrapMessage(deletedMsg.message);
                        const innerType = unwrapped ? getContentType(unwrapped) : null;

                        let delivered = false;
                        if (innerType && ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(innerType)) {
                            const mediaBuffer = await downloadMediaMessage(
                                { key: deletedMsg.key, message: unwrapped }, 
                                'buffer', 
                                {}, 
                                { logger: pino({ level: 'silent' }) }
                            ).catch(() => null);

                            if (mediaBuffer) {
                                const mediaPayload = { caption: `${header}*Deleted Media*`, mentions: [deletedMsg.participant] };
                                if (innerType === 'imageMessage') mediaPayload.image = mediaBuffer;
                                else if (innerType === 'videoMessage') mediaPayload.video = mediaBuffer;
                                else if (innerType === 'audioMessage') {
                                    mediaPayload.audio = mediaBuffer;
                                    mediaPayload.mimetype = unwrapped.audioMessage?.mimetype || 'audio/mp4';
                                    mediaPayload.ptt = !!unwrapped.audioMessage?.ptt;
                                } else if (innerType === 'stickerMessage') {
                                    mediaPayload.sticker = mediaBuffer;
                                } else {
                                    mediaPayload.document = mediaBuffer;
                                    mediaPayload.mimetype = unwrapped.documentMessage?.mimetype || 'application/octet-stream';
                                }

                                const res = await sock.sendMessage(targetChat, mediaPayload);
                                delivered = Boolean(res?.key?.id);
                            }
                        } else {
                            const deletedText = unwrapped?.conversation || 
                                                unwrapped?.extendedTextMessage?.text || 
                                                'Message content unavailable';
                            const res = await sock.sendMessage(targetChat, { 
                                text: `${header}*Deleted Message:* ${deletedText}`, 
                                mentions: [deletedMsg.participant] 
                            });
                            delivered = Boolean(res?.key?.id);
                        }

                        if (delivered) {
                            console.log(`[ANTI-DELETE TRIGGERED] Restored message to ${targetChat}`);
                        }
                    } catch (err) {}
                }
            }

            // COMMAND PARSER
            const rawUnwrapped = unwrapMessage(msg.message);
            const textContent = rawUnwrapped?.conversation || rawUnwrapped?.extendedTextMessage?.text || '';
            if (!textContent.startsWith('.')) continue;

            const args = textContent.trim().split(/\s+/);
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

            // COMMAND: .react / .r
            if (['.react', '.r', '.reaction'].includes(command)) {
                const reactionEmoji = args[1] || textContent.substring(command.length).trim() || '❤️';
                const quotedInfo = msg.message?.extendedTextMessage?.contextInfo;

                if (quotedInfo && quotedInfo.stanzaId) {
                    try {
                        const targetKey = {
                            remoteJid: fromJid,
                            id: quotedInfo.stanzaId,
                            participant: quotedInfo.participant,
                            fromMe: areJidsSameUser(quotedInfo.participant, botUserJid)
                        };

                        await sock.sendMessage(fromJid, {
                            react: {
                                text: reactionEmoji,
                                key: targetKey
                            }
                        });
                        console.log(`[.react COMMAND] Reacted with ${reactionEmoji}`);
                    } catch (err) {}
                } else {
                    await sock.sendMessage(fromJid, { text: '⚠️ Please reply to a message with `.react <emoji>`' }, { quoted: msg });
                }
                continue;
            }

            // COMMAND: .sticker / .s
            if (['.sticker', '.s', '.stk'].includes(command)) {
                const targetMedia = quotedMsg || msg.message;
                const unwrappedMedia = unwrapMessage(targetMedia);
                const mediaType = unwrappedMedia ? getContentType(unwrappedMedia) : null;

                if (['imageMessage', 'videoMessage'].includes(mediaType)) {
                    try {
                        const targetMsgObj = quotedMsg ? {
                            key: { remoteJid: fromJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                            message: unwrappedMedia
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
                    } catch (err) {}
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
                        updateConfig({ AUTO_STATUS_VIEW: 'no-dl' });
                        await sock.sendMessage(fromJid, { text: 'Done! Status View: [no-dl] ✅' }, { quoted: msg });
                    } else if (['off', 'false'].includes(param)) {
                        updateConfig({ AUTO_STATUS_VIEW: 'off' });
                        statusQueue.length = 0;
                        await sock.sendMessage(fromJid, { text: 'Done! Status View: [off] 🛑 (Permanently Disabled)' }, { quoted: msg });
                    } else {
                        const currentCfg = getConfig();
                        await sock.sendMessage(fromJid, { text: `Current Setting: Status View = [${currentCfg.AUTO_STATUS_VIEW}]\nUsage: .status no-dl | .status off` }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.delete') {
                    if (param === 'p') {
                        updateConfig({ ANTI_DELETE: 'p' });
                        await sock.sendMessage(fromJid, { text: 'Done! Anti-Delete: [p] (Send to SUDO DM) 🗑️' }, { quoted: msg });
                    } else if (param === 'g') {
                        updateConfig({ ANTI_DELETE: 'g' });
                        await sock.sendMessage(fromJid, { text: 'Done! Anti-Delete: [g] (Send to Same Group) 🗑️' }, { quoted: msg });
                    } else if (['off', 'false'].includes(param)) {
                        updateConfig({ ANTI_DELETE: 'off' });
                        await sock.sendMessage(fromJid, { text: 'Done! Anti-Delete: [off] 🛑' }, { quoted: msg });
                    } else {
                        const currentCfg = getConfig();
                        await sock.sendMessage(fromJid, { text: `Current Setting: Anti-Delete = [${currentCfg.ANTI_DELETE}]\nUsage: .delete p | .delete g | .delete off` }, { quoted: msg });
                    }
                    continue;
                }

                if (['.menu', '.settings', '.vars', '.help'].includes(command)) {
                    const currentCfg = getConfig();
                    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptimeSec / 3600);
                    const minutes = Math.floor((uptimeSec % 3600) / 60);
                    const ramUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

                    const menuText = `⚙️ *BOT SETTINGS & STATUS*\n\n` +
                                     `🛡️ *SUDO:* +${botUserJid ? botUserJid.split('@')[0] : 'Owner'}\n` +
                                     `👀 *AUTO STATUS VIEW:* ${currentCfg.AUTO_STATUS_VIEW !== 'off' ? '✅ (' + currentCfg.AUTO_STATUS_VIEW + ')' : '❎ (off)'}\n` +
                                     `🗑️ *ANTI DELETE MSG:* ${currentCfg.ANTI_DELETE !== 'off' ? '✅ (' + currentCfg.ANTI_DELETE + ')' : '❎ (off)'}\n` +
                                     `💾 *RAM USAGE:* ${ramUsage} MB\n` +
                                     `⏱️ *UPTIME:* ${hours}h ${minutes}m\n\n` +
                                     `*Commands:* .alive, .react, .forceview, .sticker, .viewall, .status, .delete, .vv, .save`.trim();

                    await sock.sendMessage(fromJid, { text: menuText }, { quoted: msg });
                    continue;
                }
            }

            // =========================================================
            // 4. VIEW-ONCE UNLOCKER (.vv) -> STRICTLY TO SUDO DM ONLY
            // =========================================================
            if (command === '.vv') {
                if (!quotedMsg || !botUserJid) continue;

                const unwrappedVO = unwrapMessage(quotedMsg);
                const voType = unwrappedVO ? getContentType(unwrappedVO) : null;

                if (['imageMessage', 'videoMessage', 'audioMessage'].includes(voType)) {
                    try {
                        const fakeMsg = {
                            key: { remoteJid: fromJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                            message: unwrappedVO
                        };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                        if (buffer) {
                            const senderName = (msg.message.extendedTextMessage.contextInfo.participant || fromJid).split('@')[0];
                            const payload = { 
                                caption: `🔓 *Unlocked View-Once Media*\n👤 *From:* @${senderName}\n💬 *Origin:* ${isGroup ? 'Group' : 'Private'}`,
                                mentions: [msg.message.extendedTextMessage.contextInfo.participant || fromJid]
                            };
                            
                            if (voType === 'imageMessage') payload.image = buffer;
                            else if (voType === 'videoMessage') payload.video = buffer;
                            else if (voType === 'audioMessage') {
                                payload.audio = buffer;
                                payload.mimetype = unwrappedVO.audioMessage?.mimetype || 'audio/mp4';
                                payload.ptt = !!unwrappedVO.audioMessage?.ptt;
                            }

                            // SENDS TO SUDO DM ONLY (Never back to originating chat)
                            const res = await sock.sendMessage(botUserJid, payload);
                            if (res?.key?.id) {
                                console.log(`[.vv COMMAND] View-Once unlocked to SUDO DM (ID: ${res.key.id})`);
                            }
                        }
                    } catch (err) {}
                } else {
                    await sock.sendMessage(botUserJid, { text: '⚠️ Quoted message is not a valid View-Once media.' });
                }
            }

            // =========================================================
            // 5. CONTENT SAVER (.save) -> STRICTLY TO SUDO DM ONLY
            // =========================================================
            if (command === '.save') {
                if (!quotedMsg || !botUserJid) continue;

                try {
                    const unwrappedSave = unwrapMessage(quotedMsg);
                    const saveType = unwrappedSave ? getContentType(unwrappedSave) : null;

                    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(saveType)) {
                        const fakeMsg = {
                            key: { remoteJid: fromJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                            message: unwrappedSave
                        };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) }).catch(() => null);

                        if (buffer) {
                            const payload = {};
                            if (saveType === 'imageMessage') payload.image = buffer;
                            else if (saveType === 'videoMessage') payload.video = buffer;
                            else if (saveType === 'audioMessage') {
                                payload.audio = buffer;
                                payload.mimetype = unwrappedSave.audioMessage?.mimetype || 'audio/mp4';
                                payload.ptt = !!unwrappedSave.audioMessage?.ptt;
                            } else if (saveType === 'stickerMessage') {
                                payload.sticker = buffer;
                            } else {
                                payload.document = buffer;
                                payload.mimetype = unwrappedSave.documentMessage?.mimetype || 'application/octet-stream';
                            }

                            // SENDS TO SUDO DM ONLY
                            const res = await sock.sendMessage(botUserJid, payload);
                            if (res?.key?.id) {
                                console.log(`[.save COMMAND] Content saved silently to SUDO DM (ID: ${res.key.id})`);
                            }
                        }
                    } else {
                        const saveText = unwrappedSave?.conversation || unwrappedSave?.extendedTextMessage?.text || 'Text content';
                        const res = await sock.sendMessage(botUserJid, { text: saveText });
                        if (res?.key?.id) {
                            console.log(`[.save COMMAND] Text saved silently to SUDO DM (ID: ${res.key.id})`);
                        }
                    }
                } catch (err) {}
            }
        }
    });
}

startBot();
