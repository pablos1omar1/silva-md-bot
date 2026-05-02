'use strict';

const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve any JID format (phone, LID, device-suffixed) to a bare phone JID.
 * Uses the same cache chain as handler.js for LID → phone lookup.
 */
function resolvePhoneJid(jid) {
    if (!jid) return null;

    // Strip device suffix: "254743706010:32@s.whatsapp.net" → "254743706010@s.whatsapp.net"
    const server = jid.split('@')[1] || '';
    const user   = jid.split('@')[0].split(':')[0];

    if (server === 'lid' || (!server && user.length > 13)) {
        // It is a LID — try to resolve to real phone number via cache
        if (global.lidPhoneCache?.size) {
            const phone = global.lidPhoneCache.get(user)
                       || global.lidPhoneCache.get(user + '@lid')
                       || global.lidPhoneCache.get(jid);
            if (phone) {
                const digits = String(phone).replace(/\D/g, '');
                if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
            }
        }
        // Not in cache yet — return null so caller can warn the user
        return null;
    }

    if (server === 's.whatsapp.net' || server === '') {
        return `${user}@s.whatsapp.net`;
    }

    // Groups / newsletters — not a personal JID
    return null;
}

function phoneNum(jid) {
    return jid ? jid.split('@')[0] : '?';
}

function deviceLabel(devices) {
    if (!Array.isArray(devices) || !devices.length) return null;

    const hosted  = devices.filter(d => d.isHosted);
    const webLike = devices.filter(d => d.id !== 0 && !d.isHosted);
    const parts   = [];

    if (hosted.length)       parts.push(`☁️ ${hosted.length} Cloud API device(s)`);
    if (webLike.length === 1) parts.push('🖥️ 1 companion (Web / Desktop)');
    else if (webLike.length > 1) parts.push(`🖥️ ${webLike.length} companions (Web / Desktop)`);

    return parts.length ? parts.join('\n│          ') : null;
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
        let targetJid  = null;
        let warnNotCached = false;

        // 1. Quoted message participant (may be LID in LID-addressed groups)
        const ctxInfo = message.message?.extendedTextMessage?.contextInfo;
        const rawQuoted = ctxInfo?.participant || ctxInfo?.remoteJid;
        if (rawQuoted) {
            targetJid = resolvePhoneJid(rawQuoted);
            if (!targetJid && rawQuoted.endsWith('@lid')) warnNotCached = true;
        }

        // 2. Mentioned user
        if (!targetJid && mentionedJid?.length) {
            targetJid = resolvePhoneJid(mentionedJid[0]);
        }

        // 3. Phone number in args
        if (!targetJid && args[0]) {
            const digits = args[0].replace(/\D/g, '');
            if (digits.length >= 7) targetJid = `${digits}@s.whatsapp.net`;
        }

        // 4. Fallback: whoever sent this command
        if (!targetJid) {
            const from = message.key.participant || message.key.remoteJid;
            targetJid  = resolvePhoneJid(from);
        }

        if (!targetJid) {
            const hint = warnNotCached
                ? '⚠️ That user\'s phone number isn\'t in my cache yet. Ask them to send a message first, then retry.'
                : '❌ Could not determine a target user. Reply to a message, mention someone, or provide a phone number.';
            return sock.sendMessage(sender, { text: hint, contextInfo }, { quoted: message });
        }

        // ── Sending indicator ──────────────────────────────────────────────
        await sock.sendMessage(sender, {
            text: `🔍 Checking device info for +${phoneNum(targetJid)}…`,
            contextInfo
        }, { quoted: message });

        // ── Parallel queries ───────────────────────────────────────────────
        const [bizProfile, usyncResult] = await Promise.allSettled([
            sock.getBusinessProfile(targetJid),
            sock.executeUSyncQuery(
                new USyncQuery()
                    .withDeviceProtocol()
                    .withContactProtocol()
                    .withUser(new USyncUser().withId(targetJid))
            )
        ]);

        // ── Parse results ──────────────────────────────────────────────────
        const biz   = bizProfile.status === 'fulfilled' ? bizProfile.value  : null;
        const usync = usyncResult.status === 'fulfilled' ? usyncResult.value : null;

        const contactData  = usync?.list?.[0];
        const isOnWA       = contactData?.contact !== false;
        const devices      = contactData?.devices?.deviceList || [];
        const isHostedAPI  = devices.some(d => d.isHosted);
        const companionCnt = devices.filter(d => d.id !== 0).length;
        const totalDevices = devices.length;

        // ── Account type ───────────────────────────────────────────────────
        let accountType, accountEmoji;
        if (isHostedAPI) {
            accountType  = 'WhatsApp Business (Cloud API)';
            accountEmoji = '☁️';
        } else if (biz?.wid) {
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
        } else if (totalDevices <= 1 && companionCnt === 0) {
            deviceLine = '📱 Phone only (no companions linked)';
        } else {
            const dLabel = deviceLabel(devices);
            deviceLine = `📱 Phone + ${dLabel || `${companionCnt} companion device(s)`}`;
        }

        // ── Platform hint ──────────────────────────────────────────────────
        let platformHint;
        if (isHostedAPI)   platformHint = '🤖 WhatsApp Business API';
        else if (biz?.wid) platformHint = '📲 WhatsApp Business App';
        else               platformHint = '📲 WhatsApp (Android / iPhone)';

        // ── Business details block ─────────────────────────────────────────
        let bizBlock = '';
        if (biz?.wid) {
            const parts = [];
            if (biz.description) parts.push(`📝 *About:*    ${biz.description.slice(0, 80)}${biz.description.length > 80 ? '…' : ''}`);
            if (biz.email)        parts.push(`📧 *Email:*    ${biz.email}`);
            if (biz.website?.[0]) parts.push(`🌐 *Website:*  ${biz.website[0]}`);
            if (biz.address)      parts.push(`📍 *Address:*  ${biz.address}`);
            if (parts.length)     bizBlock = '\n│\n│ ' + parts.join('\n│ ');
        }

        // ── Build reply ────────────────────────────────────────────────────
        const number = phoneNum(targetJid);
        const text =
`╭──────────────────────────
│ 🔎 *Device Info*
│ ─────────────────────────
│ 📞 *Number:*   +${number}
│ ${accountEmoji} *Account:*  ${accountType}
│ 📲 *Platform:*  ${platformHint}
│ 💻 *Devices:*  ${deviceLine}
│ 📡 *On WA:*    ${isOnWA ? '✅ Yes' : '❌ No'}${bizBlock}
╰──────────────────────────

_ℹ️ WhatsApp does not expose OS (iOS/Android) to other accounts. Device count shows linked companions only._`;

        await sock.sendMessage(sender, { text, contextInfo }, { quoted: message });
    }
};
