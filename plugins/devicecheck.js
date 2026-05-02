'use strict';

// ─── Country code lookup ──────────────────────────────────────────────────────
const COUNTRY_CODES = [
    ['93','Afghanistan'],['355','Albania'],['213','Algeria'],['376','Andorra'],
    ['244','Angola'],['54','Argentina'],['374','Armenia'],['61','Australia'],
    ['43','Austria'],['994','Azerbaijan'],['973','Bahrain'],['880','Bangladesh'],
    ['375','Belarus'],['32','Belgium'],['501','Belize'],['229','Benin'],
    ['975','Bhutan'],['591','Bolivia'],['387','Bosnia'],['267','Botswana'],
    ['55','Brazil'],['673','Brunei'],['359','Bulgaria'],['226','Burkina Faso'],
    ['257','Burundi'],['855','Cambodia'],['237','Cameroon'],['1','Canada/USA'],
    ['238','Cape Verde'],['236','Central African Rep.'],['235','Chad'],
    ['56','Chile'],['86','China'],['57','Colombia'],['269','Comoros'],
    ['242','Congo'],['243','DR Congo'],['506','Costa Rica'],['225','Côte d\'Ivoire'],
    ['385','Croatia'],['53','Cuba'],['357','Cyprus'],['420','Czech Republic'],
    ['45','Denmark'],['253','Djibouti'],['593','Ecuador'],['20','Egypt'],
    ['503','El Salvador'],['240','Equatorial Guinea'],['291','Eritrea'],
    ['372','Estonia'],['251','Ethiopia'],['679','Fiji'],['358','Finland'],
    ['33','France'],['241','Gabon'],['220','Gambia'],['995','Georgia'],
    ['49','Germany'],['233','Ghana'],['30','Greece'],['502','Guatemala'],
    ['224','Guinea'],['245','Guinea-Bissau'],['592','Guyana'],['509','Haiti'],
    ['504','Honduras'],['852','Hong Kong'],['36','Hungary'],['354','Iceland'],
    ['91','India'],['62','Indonesia'],['98','Iran'],['964','Iraq'],
    ['353','Ireland'],['972','Israel'],['39','Italy'],['1876','Jamaica'],
    ['81','Japan'],['962','Jordan'],['7','Kazakhstan/Russia'],['254','Kenya'],
    ['82','South Korea'],['965','Kuwait'],['996','Kyrgyzstan'],['856','Laos'],
    ['371','Latvia'],['961','Lebanon'],['266','Lesotho'],['231','Liberia'],
    ['218','Libya'],['423','Liechtenstein'],['370','Lithuania'],['352','Luxembourg'],
    ['853','Macau'],['261','Madagascar'],['265','Malawi'],['60','Malaysia'],
    ['960','Maldives'],['223','Mali'],['356','Malta'],['222','Mauritania'],
    ['230','Mauritius'],['52','Mexico'],['373','Moldova'],['976','Mongolia'],
    ['382','Montenegro'],['212','Morocco'],['258','Mozambique'],['95','Myanmar'],
    ['264','Namibia'],['977','Nepal'],['31','Netherlands'],['64','New Zealand'],
    ['505','Nicaragua'],['227','Niger'],['234','Nigeria'],['47','Norway'],
    ['968','Oman'],['92','Pakistan'],['507','Panama'],['675','Papua New Guinea'],
    ['595','Paraguay'],['51','Peru'],['63','Philippines'],['48','Poland'],
    ['351','Portugal'],['974','Qatar'],['40','Romania'],['250','Rwanda'],
    ['966','Saudi Arabia'],['221','Senegal'],['381','Serbia'],['232','Sierra Leone'],
    ['65','Singapore'],['421','Slovakia'],['386','Slovenia'],['252','Somalia'],
    ['27','South Africa'],['211','South Sudan'],['34','Spain'],['94','Sri Lanka'],
    ['249','Sudan'],['268','Swaziland'],['46','Sweden'],['41','Switzerland'],
    ['963','Syria'],['886','Taiwan'],['992','Tajikistan'],['255','Tanzania'],
    ['66','Thailand'],['228','Togo'],['216','Tunisia'],['90','Turkey'],
    ['993','Turkmenistan'],['256','Uganda'],['380','Ukraine'],
    ['971','United Arab Emirates'],['44','United Kingdom'],['598','Uruguay'],
    ['998','Uzbekistan'],['58','Venezuela'],['84','Vietnam'],['967','Yemen'],
    ['260','Zambia'],['263','Zimbabwe'],
];
// Sort longest prefix first so greedy match works correctly
COUNTRY_CODES.sort((a, b) => b[0].length - a[0].length);

function getCountry(number) {
    const digits = String(number).replace(/\D/g, '');
    for (const [code, name] of COUNTRY_CODES) {
        if (digits.startsWith(code)) return `${name} (+${code})`;
    }
    return 'Unknown';
}

// ─── LID → phone JID resolution ───────────────────────────────────────────────
function resolvePhoneJid(jid) {
    if (!jid) return null;
    const server = (jid.split('@')[1] || '');
    const user   = jid.split('@')[0].split(':')[0];

    if (server === 'lid') {
        if (global.lidPhoneCache?.size) {
            const phone = global.lidPhoneCache.get(user)
                       || global.lidPhoneCache.get(user + '@lid')
                       || global.lidPhoneCache.get(jid);
            if (phone) {
                const digits = String(phone).replace(/\D/g, '');
                if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
            }
        }
        return null; // LID not cached yet
    }
    if (server === 's.whatsapp.net' || server === '') {
        return `${user}@s.whatsapp.net`;
    }
    return null; // group / newsletter
}

function phoneNum(jid) {
    return jid ? jid.split('@')[0] : '?';
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
module.exports = {
    commands:    ['device', 'devicecheck', 'checkdevice', 'wainfo'],
    description: 'Check WhatsApp account type, linked devices, status and more',
    usage:       '.device @user  |  reply a message  |  .device 2547XXXXXXXX',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, { sender, contextInfo, mentionedJid }) => {

        // ── Resolve target JID ──────────────────────────────────────────────
        let targetJid   = null;
        let lidNotCached = false;

        const ctxInfo    = message.message?.extendedTextMessage?.contextInfo;
        const rawQuoted  = ctxInfo?.participant || ctxInfo?.remoteJid;

        if (rawQuoted) {
            targetJid = resolvePhoneJid(rawQuoted);
            if (!targetJid && rawQuoted.endsWith('@lid')) lidNotCached = true;
        }
        if (!targetJid && mentionedJid?.length) {
            targetJid = resolvePhoneJid(mentionedJid[0]);
        }
        if (!targetJid && args[0]) {
            const digits = args[0].replace(/\D/g, '');
            if (digits.length >= 7) targetJid = `${digits}@s.whatsapp.net`;
        }
        if (!targetJid) {
            const from = message.key.participant || message.key.remoteJid;
            targetJid  = resolvePhoneJid(from);
        }

        if (!targetJid) {
            return sock.sendMessage(sender, {
                text: lidNotCached
                    ? '⚠️ That user\'s phone number isn\'t cached yet — ask them to send a message first, then retry.'
                    : '❌ Provide a number, mention someone, or reply to their message.',
                contextInfo
            }, { quoted: message });
        }

        const number = phoneNum(targetJid);

        await sock.sendMessage(sender, {
            text: `🔍 Fetching info for +${number}…`,
            contextInfo
        }, { quoted: message });

        // ── Parallel queries ───────────────────────────────────────────────
        const [
            bizResult,
            devResult,
            statusResult,
            picResult,
        ] = await Promise.allSettled([
            sock.getBusinessProfile(targetJid),
            // getUSyncDevices is the same internal function used when sending messages
            typeof sock.getUSyncDevices === 'function'
                ? sock.getUSyncDevices([targetJid], false, false)
                : Promise.resolve([]),
            sock.fetchStatus(targetJid),
            sock.profilePictureUrl(targetJid, 'preview', 5000),
        ]);

        // ── Parse ──────────────────────────────────────────────────────────
        const biz      = bizResult.status    === 'fulfilled' ? bizResult.value    : null;
        const devJids  = devResult.status     === 'fulfilled' ? (devResult.value || []) : [];
        const statusL  = statusResult.status  === 'fulfilled' ? (statusResult.value || []) : [];
        const picUrl   = picResult.status     === 'fulfilled' ? picResult.value   : null;

        // Device count: devJids = [{user, device}, ...]
        // device 0 = primary phone, 1+ = companions
        const companions  = devJids.filter(d => d.device !== 0).length;
        const totalDev    = devJids.length; // includes the primary phone

        // Status text
        const statusEntry = statusL.find(e => e.status)?.status;
        const statusText  = statusEntry?.status || null;

        // Push name
        const pushName = global.pushNameCache?.get(number)
                      || global.pushNameCache?.get(targetJid)
                      || null;

        // Account type
        const isBiz = !!(biz?.wid);

        // ── Build device line ──────────────────────────────────────────────
        let deviceLine;
        if (totalDev === 0) {
            deviceLine = '📱 Unknown (query returned no data)';
        } else if (companions === 0) {
            deviceLine = '📱 Phone only';
        } else {
            deviceLine = `📱 Phone + ${companions} companion${companions > 1 ? 's' : ''} (Web/Desktop)`;
        }

        // ── Account type ───────────────────────────────────────────────────
        let accountLine, platformLine;
        if (biz?.wid) {
            accountLine  = '🏢 WhatsApp Business';
            platformLine = '📲 WhatsApp Business App';
        } else {
            accountLine  = '👤 Personal (WhatsApp)';
            platformLine = '📲 WhatsApp (Android / iPhone)';
        }

        // ── Country ────────────────────────────────────────────────────────
        const country = getCountry(number);

        // ── Business details ───────────────────────────────────────────────
        let bizBlock = '';
        if (biz?.wid) {
            const rows = [];
            if (biz.description) rows.push(`📝 *About:*    ${biz.description.slice(0, 100)}${biz.description.length > 100 ? '…' : ''}`);
            if (biz.email)        rows.push(`📧 *Email:*    ${biz.email}`);
            if (biz.website?.[0]) rows.push(`🌐 *Website:*  ${biz.website[0]}`);
            if (biz.address)      rows.push(`📍 *Address:*  ${biz.address}`);
            if (rows.length)      bizBlock = '\n│\n│ ' + rows.join('\n│ ');
        }

        // ── Compose reply ──────────────────────────────────────────────────
        const lines = [
            `╭────────────────────────────`,
            `│ 🔎 *WhatsApp Info*`,
            `│ ───────────────────────────`,
            `│ 📞 *Number:*    +${number}`,
        ];
        if (pushName)    lines.push(`│ 👤 *Name:*      ${pushName}`);
        lines.push(
            `│ 🌍 *Country:*   ${country}`,
            `│ ${accountLine.split(' ')[0]} *Account:*   ${accountLine.split(' ').slice(1).join(' ')}`,
            `│ 📲 *Platform:*  ${platformLine}`,
            `│ 💻 *Devices:*   ${deviceLine}`,
        );
        if (statusText)  lines.push(`│ 💬 *Status:*    ${statusText.slice(0, 80)}${statusText.length > 80 ? '…' : ''}`);
        lines.push(`╰────────────────────────────`);
        lines.push('');
        lines.push('_ℹ️ WhatsApp does not share exact OS (iOS/Android). Companion count = linked Web/Desktop sessions._');

        const text = lines.join('\n');

        if (picUrl) {
            try {
                await sock.sendMessage(sender, {
                    image:    { url: picUrl },
                    caption:  text,
                    contextInfo
                }, { quoted: message });
                return;
            } catch { /* fall through to text-only */ }
        }

        await sock.sendMessage(sender, { text, contextInfo }, { quoted: message });
    }
};
