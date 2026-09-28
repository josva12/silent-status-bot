const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    getDevice
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Logger configuration to silence library-level noise
const logger = pino({
    level: 'silent'
});

// Low-level stderr interceptor to keep PM2 logs clean from Baileys noise & closed session logs
const origStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
    const str = chunk.toString();
    if (
        str.includes('Decrypted message with closed session') ||
        str.includes('SessionEntry') ||
        str.includes('MessageCounterError') ||
        str.includes('Failed to decrypt') ||
        str.includes('428')
    ) {
        return true;
    }
    return origStderrWrite.apply(process.stderr, arguments);
};

// Catch unhandled rejections from dropped sockets without crashing or dumping clean logs
process.on('unhandledRejection', (reason) => {
    if (reason?.output?.statusCode === 428 || reason?.message?.includes('Connection Closed')) {
        return;
    }
});

/**
 * Helper: Extract normalized sender JID/LID across group and direct messages
 */
function getSenderJid(msg) {
    return msg.key.participant || msg.key.remoteJid;
}

/**
 * Helper: Recursively unwrap quoted or view-once messages
 * Fixes .vv and .save failing on nested viewOnceMessageV2 and ephemeral wrappers
 */
function unwrapMessage(msg) {
    let m = msg;
    if (!m) return null;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    return m;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Connection Handler
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`Connection dropped (${statusCode || 'Unknown'}). Reconnecting...`);
                startBot();
            } else {
                console.log('Session logged out. Please re-scan QR code.');
            }
        } else if (connection === 'open') {
            console.log('✅ Silent Status Bot Active! Designed by Josva.');
        }
    });

    // Auto Status Viewer & Command Handler
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            for (const msg of chatUpdate.messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;

                // 1. AUTO-VIEW STATUSES
                if (remoteJid === 'status@broadcast') {
                    await sock.readMessages([msg.key]);
                    console.log(`[STATUS VIEWED & SYNCED] ID: ${msg.key.id} From: ${getSenderJid(msg)}`);
                    continue;
                }

                // Unpack message structure
                const rawMessage = unwrapMessage(msg.message);
                if (!rawMessage) continue;

                // Extract text body
                const body = rawMessage.conversation ||
                    rawMessage.extendedTextMessage?.text ||
                    rawMessage.imageMessage?.caption ||
                    rawMessage.videoMessage?.caption || '';

                const command = body.trim().toLowerCase().split(' ')[0];

                // Extract contextual quoted message for commands
                const contextInfo = rawMessage.extendedTextMessage?.contextInfo ||
                    rawMessage.imageMessage?.contextInfo ||
                    rawMessage.videoMessage?.contextInfo ||
                    rawMessage.audioMessage?.contextInfo;

                const quotedMsg = contextInfo ? unwrapMessage(contextInfo.quotedMessage) : null;

                // 2. COMMAND: .vv (View-Once Saver / Unlocker)
                if (command === '.vv') {
                    if (!quotedMsg) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Please reply to a View-Once media message with *.vv*' }, { quoted: msg });
                        continue;
                    }

                    // Search for media keys across standard and view-once wrappers
                    const mediaType = Object.keys(quotedMsg).find(k => k.endsWith('Message'));
                    const mediaObj = quotedMsg[mediaType];

                    if (!mediaType || !mediaObj) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Quoted message contains no downloadable media.' }, { quoted: msg });
                        continue;
                    }

                    const typeMap = {
                        imageMessage: 'image',
                        videoMessage: 'video',
                        audioMessage: 'audio'
                    };

                    const downloadType = typeMap[mediaType];
                    if (!downloadType) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Unsupported media format.' }, { quoted: msg });
                        continue;
                    }

                    const stream = await downloadContentFromMessage(mediaObj, downloadType);
                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const caption = mediaObj.caption ? `*Caption:* ${mediaObj.caption}` : '🔓 *View-Once Recovered*';

                    if (downloadType === 'image') {
                        await sock.sendMessage(remoteJid, { image: buffer, caption }, { quoted: msg });
                    } else if (downloadType === 'video') {
                        await sock.sendMessage(remoteJid, { video: buffer, caption }, { quoted: msg });
                    } else if (downloadType === 'audio') {
                        await sock.sendMessage(remoteJid, { audio: buffer, ptt: true }, { quoted: msg });
                    }
                }

                // 3. COMMAND: .save (Status / Media Saver)
                if (command === '.save') {
                    if (!quotedMsg) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Reply to a status or media message with *.save*' }, { quoted: msg });
                        continue;
                    }

                    const mediaType = Object.keys(quotedMsg).find(k => k.endsWith('Message'));
                    const mediaObj = quotedMsg[mediaType];

                    if (!mediaObj) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Quoted content does not contain media.' }, { quoted: msg });
                        continue;
                    }

                    const downloadType = mediaType.replace('Message', '');
                    const stream = await downloadContentFromMessage(mediaObj, downloadType);
                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const caption = mediaObj.caption || '📥 *Saved via Silent-Status-Bot*';

                    if (downloadType === 'image') {
                        await sock.sendMessage(remoteJid, { image: buffer, caption }, { quoted: msg });
                    } else if (downloadType === 'video') {
                        await sock.sendMessage(remoteJid, { video: buffer, caption }, { quoted: msg });
                    } else if (downloadType === 'audio') {
                        await sock.sendMessage(remoteJid, { audio: buffer, ptt: true }, { quoted: msg });
                    }
                }

                // 4. COMMAND: .delete (Delete Quoted Message)
                if (command === '.delete' || command === '.del') {
                    if (!contextInfo || !contextInfo.stanzaId) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Reply to the message you want to delete with *.delete*' }, { quoted: msg });
                        continue;
                    }

                    // Check if the bot sent the target message
                    const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const targetParticipant = contextInfo.participant || remoteJid;
                    const isFromMe = targetParticipant === myJid;

                    const deleteKey = {
                        remoteJid: remoteJid,
                        fromMe: isFromMe,
                        id: contextInfo.stanzaId,
                        participant: targetParticipant
                    };

                    await sock.sendMessage(remoteJid, { delete: deleteKey });
                }
            }
        } catch (err) {
            console.error('Error handling message:', err.message);
        }
    });
}

startBot();
