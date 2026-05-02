'use strict';

const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bareJid(jid) {
    if (!jid) return null;
    return jid.split(':')[0].split('@')[0] + '@s.whatsapp.net';
}

function phoneNum(jid) {
    return jid ? jid.split('@')[0].split(':')[0] : '?';
}

// Map linked-device count + isHosted flag to a human-readable label
function deviceLabel(devices) {
    if (!Array.isArray(devices) || !devices.length) return null;

    const companions = devices.filter(d => d.id !== 0);
    const hosted     = devices.filter(d => d.isHosted);

    const parts = [];

    if (hosted.length) {
        parts.push(`☁️ WhatsApp Cloud API (${hosted.length} hosted)`);
    }

    const webLike = companions.filter(d => !d.isHosted);
    if (webLike.length === 1) {
        parts.push('🖥️ 1 companion device (Web / Desktop)');
    } else if (webLike.length > 1) {
        parts.push(`🖥️ ${webLike.length} companion devices (Web / Desktop)`);
    }

    return parts.length ? parts.join('\n│ ') : null;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

module.exports = {
    commands:    ['device', 'devicecheck', 'checkdevice', 'wainfo'],
    description: 'Check what type of WhatsApp account and devices a user has',
    usage:       '.device @user  |  reply a message  |  .device 2547XXXXXXXX',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, { sender, contextInfo, mentionedJid }) => {

        // ── Resolve target JID ──────────────────────────────────────────────
        let targetJid = null;

        // 1. Quoted message participant
        const quotedParticipant = message.message?.extendedTextMessage?.contextInfo?.participant
                               || message.message?.extendedTextMessage?.contextInfo?.remoteJid;
        if (quotedParticipant) {
            targetJid = bareJid(quotedParticipant);
        }

        // 2. Mentioned user
        if (!targetJid && mentionedJid?.length) {
            targetJid = bareJid(mentionedJid[0]);
        }

        // 3. Phone number in args
        if (!targetJid && args[0]) {
            const digits = args[0].replace(/\D/g, '');
            if (digits.length >= 7) targetJid = `${digits}@s.whatsapp.net`;
        }

        // 4. Fallback: the person who ran the command
        if (!targetJid) {
            const from = message.key.participant || message.key.remoteJid;
            targetJid  = bareJid(from);
        }

        if (!targetJid) {
            return sock.sendMessage(sender, {
                text: '❌ Could not determine a target user. Reply to someone\'s message, mention them, or provide a phone number.',
                contextInfo
            }, { quoted: message });
        }

        // ── Sending indicator ──────────────────────────────────────────────
        await sock.sendMessage(sender, {
            text: `🔍 Checking device info for +${phoneNum(targetJid)}…`,
            contextInfo
        }, { quoted: message });

        // ── Parallel queries ───────────────────────────────────────────────
        const [bizProfile, usyncResult] = await Promise.allSettled([

            // WhatsApp Business profile (null = personal account)
            sock.getBusinessProfile(targetJid),

            // USync: contact on WhatsApp + device list
            sock.executeUSyncQuery(
                new USyncQuery()
                    .withDeviceProtocol()
                    .withContactProtocol()
                    .withUser(
                        new USyncUser().withId(targetJid)
                    )
            )
        ]);

        // ── Parse results ──────────────────────────────────────────────────
        const biz     = bizProfile.status === 'fulfilled' ? bizProfile.value   : null;
        const usync   = usyncResult.status === 'fulfilled' ? usyncResult.value : null;

        const contactData = usync?.list?.[0];
        const isOnWA      = contactData?.contact !== false;  // contact protocol returns true/false
        const devices     = contactData?.devices?.deviceList || [];

        const isHostedAPI  = devices.some(d => d.isHosted);
        const companionCnt = devices.filter(d => d.id !== 0).length;
        const totalDevices = devices.length;

        // ── Account type ───────────────────────────────────────────────────
        let accountType, accountEmoji;
        if (isHostedAPI) {
            accountType  = 'WhatsApp Business (Cloud API)';
            accountEmoji = '☁️';
        } else if (biz && biz.wid) {
            accountType  = 'WhatsApp Business';
            accountEmoji = '🏢';
        } else {
            accountType  = 'Personal (WhatsApp)';
            accountEmoji = '👤';
        }

        // ── Device count line ──────────────────────────────────────────────
        let deviceLine;
        if (!isOnWA) {
            deviceLine = '❌ Not registered on WhatsApp';
        } else if (totalDevices === 0) {
            deviceLine = '📱 Phone only (no companions linked)';
        } else if (totalDevices === 1 && companionCnt === 0) {
            deviceLine = '📱 Phone only (no companions linked)';
        } else {
            const dLabel = deviceLabel(devices);
            deviceLine = `📱 Phone + ${dLabel || `${companionCnt} companion device(s)`}`;
        }

        // ── Platform guess (soft inference) ───────────────────────────────
        // WhatsApp does not expose the OS/platform to third parties.
        // We can only infer from account type patterns.
        let platformHint = '';
        if (isHostedAPI) {
            platformHint = '\n│ 🤖 *Platform:*     WhatsApp Business API';
        } else if (biz && biz.wid) {
            platformHint = '\n│ 📲 *Platform:*     WhatsApp Business App';
        } else {
            platformHint = '\n│ 📲 *Platform:*     WhatsApp (Android / iPhone)';
        }

        // ── Business details ───────────────────────────────────────────────
        let bizBlock = '';
        if (biz && biz.wid) {
            const parts = [];
            if (biz.description) parts.push(`📝 *About:*         ${biz.description.slice(0, 80)}${biz.description.length > 80 ? '…' : ''}`);
            if (biz.email)       parts.push(`📧 *Email:*         ${biz.email}`);
            if (biz.website?.[0]) parts.push(`🌐 *Website:*       ${biz.website[0]}`);
            if (biz.address)     parts.push(`📍 *Address:*       ${biz.address}`);
            if (parts.length)    bizBlock = '\n│\n│ ' + parts.join('\n│ ');
        }

        // ── Build reply ────────────────────────────────────────────────────
        const number = phoneNum(targetJid);
        const text =
`╭──────────────────────────
│ 🔎 *Device Info*
│ ─────────────────────────
│ 📞 *Number:*     +${number}
│ ${accountEmoji} *Account:*    ${accountType}${platformHint}
│ 💻 *Devices:*    ${deviceLine}
│ 📡 *On WhatsApp:* ${isOnWA ? '✅ Yes' : '❌ No'}${bizBlock}
╰──────────────────────────

_ℹ️ WhatsApp does not share the exact OS (iOS/Android) with other accounts. Device count reflects linked companions (Web, Desktop, etc.)._`;

        await sock.sendMessage(sender, { text, contextInfo }, { quoted: message });
    }
};
