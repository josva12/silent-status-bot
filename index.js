const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    WA_DEFAULT_EPHEMERAL
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const os = require('os');
const qrcode = require('qrcode-terminal');

// Logger configuration
const logger = pino({ level: 'silent' });

// Intercept low-level stderr warnings
const origStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
    const str = chunk.toString();
    if (
        str.includes('Decrypted message with closed session') ||
        str.includes('SessionEntry') ||
        str.includes('MessageCounterError') ||
        str.includes('Failed to decrypt') ||
        str.includes('printQRInTerminal option has been deprecated') ||
        str.includes('428')
    ) {
        return true;
    }
    return origStderrWrite.apply(process.stderr, arguments);
};

process.on('unhandledRejection', (reason) => {
    if (reason?.output?.statusCode === 428 || reason?.message?.includes('Connection Closed')) {
        return;
    }
});

// Bot Runtime State
const startTime = Date.now();
const config = {
    autoViewStatus: true,
    antiDeleteMode: 'g'
};

const messageStore = new Map();

function getSenderJid(msg) {
    return msg.key.participant || msg.key.remoteJid;
}

function unwrapMessage(msg) {
    let m = msg;
    if (!m) return null;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    return m;
}

function getUptime() {
    const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        // Ensures key exchange payloads are sent cleanly to self/primary devices
        emitOwnEvents: true 
    });

    sock.ev.on('creds.update', saveCreds);

    // Connection Manager
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- SCAN THIS QR CODE TO LINK WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`[RECONNECTING] Reason code: ${statusCode || 'Unknown'}`);
                startBot();
            } else {
                console.log('Session logged out. Clear ./session directory and restart.');
            }
        } else if (connection === 'open') {
            console.log('✅ Silent Status Bot Active! Designed by Josva.');
        }
    });

    // Message Processing Engine
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            for (const msg of chatUpdate.messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                const isGroup = remoteJid.endsWith('@g.us');
                const isStatus = remoteJid === 'status@broadcast';

                if (!isStatus && msg.key.id) {
                    messageStore.set(msg.key.id, msg);
                    if (messageStore.size > 2000) {
                        const firstKey = messageStore.keys().next().value;
                        messageStore.delete(firstKey);
                    }
                }

                // Auto-View Statuses
                if (isStatus) {
                    if (config.autoViewStatus) {
                        const participant = getSenderJid(msg);
                        await sock.readMessages([msg.key]);
                        await sock.sendReceipt(
                            msg.key.remoteJid,
                            participant,
                            [msg.key.id],
                            'read-self'
                        );
                        console.log(`[STATUS VIEWED & SYNCED] ID: ${msg.key.id} From: ${participant}`);
                    }
                    continue;
                }

                const rawMessage = unwrapMessage(msg.message);
                if (!rawMessage) continue;

                const body = rawMessage.conversation ||
                    rawMessage.extendedTextMessage?.text ||
                    rawMessage.imageMessage?.caption ||
                    rawMessage.videoMessage?.caption || '';

                if (!body.startsWith('.')) continue;

                const args = body.trim().split(/\s+/);
                const command = args[0]?.toLowerCase();
                const subArg = args[1]?.toLowerCase();

                const senderJid = getSenderJid(msg);
                const isOwner = msg.key.fromMe || senderJid.includes(sock.user.id.split(':')[0]);
                if (!isOwner) continue;

                const contextInfo = rawMessage.extendedTextMessage?.contextInfo ||
                    rawMessage.imageMessage?.contextInfo ||
                    rawMessage.videoMessage?.contextInfo ||
                    rawMessage.audioMessage?.contextInfo;

                const quotedMsg = contextInfo ? unwrapMessage(contextInfo.quotedMessage) : null;
                const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                // --- IN-CHAT COMMANDS ---

                if (command === '.alive' || command === '.ping') {
                    const statusText = `🤖 *Silent Status Bot is Active*\n\n` +
                        `⏱️ *Uptime:* ${getUptime()}\n` +
                        `👁️ *Auto Status View:* ${config.autoViewStatus ? 'ENABLED' : 'DISABLED'}\n` +
                        `🛡️ *Anti-Delete Mode:* ${config.antiDeleteMode.toUpperCase()}\n` +
                        `💻 *Host:* Ubuntu Linux`;
                    await sock.sendMessage(remoteJid, { text: statusText }, { quoted: msg });
                    continue;
                }

                if (command === '.sticker' || command === '.s') {
                    const targetMsg = quotedMsg || rawMessage;
                    const mediaType = targetMsg.imageMessage ? 'image' : targetMsg.videoMessage ? 'video' : null;

                    if (!mediaType) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Reply to an image or short video with *.sticker*' }, { quoted: msg });
                        continue;
                    }

                    const mediaObj = targetMsg[`${mediaType}Message`];
                    const stream = await downloadContentFromMessage(mediaObj, mediaType);
                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    await sock.sendMessage(remoteJid, { sticker: buffer }, { quoted: msg });
                    continue;
                }

                if (command === '.status') {
                    if (subArg === 'off' || subArg === 'no-dl') {
                        config.autoViewStatus = false;
                        await sock.sendMessage(remoteJid, { text: '🔴 Auto Status Viewing *DISABLED*.' }, { quoted: msg });
                    } else if (subArg === 'on') {
                        config.autoViewStatus = true;
                        await sock.sendMessage(remoteJid, { text: '🟢 Auto Status Viewing *ENABLED*.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'ℹ️ Usage: *.status on* | *.status off*' }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.delete' || command === '.antidelete') {
                    if (subArg === 'p') {
                        config.antiDeleteMode = 'p';
                        await sock.sendMessage(remoteJid, { text: '🛡️ Anti-Delete set to *PRIVATE DM ONLY*.' }, { quoted: msg });
                    } else if (subArg === 'g') {
                        config.antiDeleteMode = 'g';
                        await sock.sendMessage(remoteJid, { text: '🛡️ Anti-Delete set to *GROUPS & PRIVATE DMs*.' }, { quoted: msg });
                    } else if (subArg === 'off') {
                        config.antiDeleteMode = 'off';
                        await sock.sendMessage(remoteJid, { text: '🔴 Anti-Delete *DISABLED*.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'ℹ️ Usage: *.delete p* | *.delete g* | *.delete off*' }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.viewall') {
                    await sock.sendMessage(remoteJid, { text: '🔄 *Sweeping status updates...*' }, { quoted: msg });
                    await sock.sendMessage(remoteJid, { text: '✅ *Status updates synced.*' }, { quoted: msg });
                    continue;
                }

                if (command === '.vv') {
                    if (!quotedMsg) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Reply to a View-Once message with *.vv*' }, { quoted: msg });
                        continue;
                    }

                    const mediaTypeKey = Object.keys(quotedMsg).find(k => k.endsWith('Message'));
                    const mediaObj = quotedMsg[mediaTypeKey];

                    if (!mediaTypeKey || !mediaObj) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Message contains no media.' }, { quoted: msg });
                        continue;
                    }

                    const typeMap = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' };
                    const downloadType = typeMap[mediaTypeKey];

                    const stream = await downloadContentFromMessage(mediaObj, downloadType);
                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const caption = mediaObj.caption ? `🔓 *View-Once Recovered*\n\n*Caption:* ${mediaObj.caption}` : '🔓 *View-Once Recovered*';

                    if (downloadType === 'image') await sock.sendMessage(remoteJid, { image: buffer, caption }, { quoted: msg });
                    else if (downloadType === 'video') await sock.sendMessage(remoteJid, { video: buffer, caption }, { quoted: msg });
                    else if (downloadType === 'audio') await sock.sendMessage(remoteJid, { audio: buffer, ptt: true }, { quoted: msg });
                    continue;
                }

                if (command === '.save') {
                    if (!quotedMsg) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Reply to any message with *.save*' }, { quoted: msg });
                        continue;
                    }

                    const mediaTypeKey = Object.keys(quotedMsg).find(k => k.endsWith('Message'));
                    const mediaObj = quotedMsg[mediaTypeKey];

                    if (mediaObj && mediaTypeKey) {
                        const downloadType = mediaTypeKey.replace('Message', '');
                        const stream = await downloadContentFromMessage(mediaObj, downloadType);
                        let buffer = Buffer.alloc(0);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        const caption = mediaObj.caption ? `📥 *Saved Media*\n\n*Caption:* ${mediaObj.caption}` : '📥 *Saved Media*';

                        if (downloadType === 'image') await sock.sendMessage(ownerJid, { image: buffer, caption });
                        else if (downloadType === 'video') await sock.sendMessage(ownerJid, { video: buffer, caption });
                        else if (downloadType === 'audio') await sock.sendMessage(ownerJid, { audio: buffer, ptt: true });
                    } else if (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text) {
                        const textContent = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text;
                        await sock.sendMessage(ownerJid, { text: `📥 *Saved Note:*\n\n${textContent}` });
                    }

                    await sock.sendMessage(remoteJid, { text: '📥 Saved to your private DM!' }, { quoted: msg });
                    continue;
                }

                if (command === '.settings' || command === '.menu' || command === '.vars') {
                    const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
                    const freeMemGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
                    const usedMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);

                    const dashboard = `⚙️ *SYSTEM & BOT CONFIGURATION*\n\n` +
                        `👁️ *Auto Status View:* ${config.autoViewStatus ? 'ENABLED' : 'DISABLED'}\n` +
                        `🛡️ *Anti-Delete Mode:* ${config.antiDeleteMode.toUpperCase()}\n` +
                        `⏱️ *Uptime:* ${getUptime()}\n` +
                        `🧠 *Process Memory:* ${usedMemMB} MB\n` +
                        `🖥️ *Server RAM Free:* ${freeMemGB} GB / ${totalMemGB} GB\n` +
                        `📦 *Cached Messages:* ${messageStore.size}`;

                    await sock.sendMessage(remoteJid, { text: dashboard }, { quoted: msg });
                    continue;
                }

            }
        } catch (err) {
            console.error('Error processing command:', err.message);
        }
    });

    // Anti-Delete Detector
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                if (config.antiDeleteMode === 'off') return;

                const deletedId = update.update.protocolMessage.key.id;
                const savedMsg = messageStore.get(deletedId);

                if (!savedMsg) return;

                const isGroup = savedMsg.key.remoteJid.endsWith('@g.us');
                if (config.antiDeleteMode === 'p' && isGroup) return;

                const sender = getSenderJid(savedMsg);
                const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const rawMsg = unwrapMessage(savedMsg.message);

                const alertHeader = `🚨 *ANTI-DELETE DETECTED*\n\n` +
                    `👤 *Sender:* @${sender.split('@')[0]}\n` +
                    `📍 *Chat:* ${isGroup ? 'Group Chat' : 'Private DM'}\n\n`;

                if (rawMsg.conversation || rawMsg.extendedTextMessage?.text) {
                    const text = rawMsg.conversation || rawMsg.extendedTextMessage.text;
                    await sock.sendMessage(ownerJid, {
                        text: `${alertHeader}💬 *Deleted Message:* ${text}`,
                        mentions: [sender]
                    });
                }
            }
        }
    });
}

startBot();
