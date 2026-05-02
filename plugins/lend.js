'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { fmt } = require('../lib/theme');

const SESSION_SERVER = 'https://session.silvatech.co.ke';
const DATA_PATH      = path.join(__dirname, '../data/lends.json');

// ─── Persistence ──────────────────────────────────────────────────────────────
function load() {
    try {
        if (fs.existsSync(DATA_PATH)) return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    } catch { /* ignore */ }
    return { pending: {}, approved: {}, rejected: {} };
}
function save(data) {
    try {
        fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
}

// ─── Pair code fetch ──────────────────────────────────────────────────────────
async function fetchPairCode(number) {
    const clean = String(number).replace(/\D/g, '');
    const res = await axios.get(`${SESSION_SERVER}/code`, {
        params:  { number: clean },
        timeout: 15000,
        headers: { 'User-Agent': 'SilvaMD-Bot/2.0' }
    });
    const code = res.data?.code || res.data?.pairCode || res.data?.pair_code;
    if (!code) throw new Error('No code returned');
    return code;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
module.exports = {
    commands:    ['lend', 'approvelend', 'rejectlend', 'lendlist', 'lendstatus', 'revokelend'],
    description: 'Lend the bot to a user — requests owner approval then delivers a pair code',
    usage:       '.lend 2547XXXXXXXX | (owner) .approvelend 2547XXXXXXXX | .rejectlend 2547XXXXXXXX',
    permission:  'public',
    group:       true,
    private:     true,

    run: async (sock, message, args, ctx) => {
        const { sender, jid, isOwner, contextInfo, reply } = ctx;

        const ownerJid   = `${(process.env.OWNER_NUMBER || global.botNum || '').replace(/\D/g, '')}@s.whatsapp.net`;
        const senderNum  = sender.split('@')[0];
        const pushName   = global.pushNameCache?.get(senderNum)
                        || global.pushNameCache?.get(sender)
                        || 'User';

        const rawCmd = (
            message.message?.extendedTextMessage?.text ||
            message.message?.conversation || ''
        ).trim().split(/\s+/)[0].replace(/^\./, '').toLowerCase();

        let db = load();

        // ── .lendlist — owner only ─────────────────────────────────────────
        if (rawCmd === 'lendlist') {
            if (!isOwner) return reply(fmt('⛔ Only the owner can view the lend list.'));
            const pending  = Object.values(db.pending);
            const approved = Object.values(db.approved);
            if (!pending.length && !approved.length) {
                return reply(fmt('📋 *Lend List*\n\nNo pending or active lend requests.'));
            }
            const pLines = pending.map(r =>
                `⏳ *${r.requestorName}* (+${r.requestorNum}) → +${r.targetNumber}\n   _Requested: ${new Date(r.requestedAt).toLocaleString()}_`
            ).join('\n');
            const aLines = approved.map(r =>
                `✅ *${r.requestorName}* (+${r.requestorNum}) → +${r.targetNumber}\n   _Approved: ${new Date(r.approvedAt).toLocaleString()}_`
            ).join('\n');
            return reply(fmt(
                `📋 *Lend Registry*\n\n` +
                (pLines ? `*Pending (${pending.length}):*\n${pLines}\n\n` : '') +
                (aLines ? `*Active (${approved.length}):*\n${aLines}` : '')
            ));
        }

        // ── .lendstatus — check own request ───────────────────────────────
        if (rawCmd === 'lendstatus') {
            const mine = db.pending[senderNum] || db.approved[senderNum] || db.rejected[senderNum];
            if (!mine) return reply(fmt('ℹ️ You have no lend request on record.\n\nUse `.lend 2547XXXXXXXX` to request.'));
            const status = db.approved[senderNum] ? '✅ Approved'
                         : db.rejected[senderNum] ? '❌ Rejected'
                         : '⏳ Pending owner approval';
            return reply(fmt(
                `🤝 *Your Lend Request*\n\n` +
                `Number requested: +${mine.targetNumber}\n` +
                `Status: *${status}*\n` +
                `Requested: ${new Date(mine.requestedAt).toLocaleString()}`
            ));
        }

        // ── .approvelend — owner only ─────────────────────────────────────
        if (rawCmd === 'approvelend') {
            if (!isOwner) return reply(fmt('⛔ Only the owner can approve lend requests.'));

            const targetNum = args.join('').replace(/\D/g, '') ||
                (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]?.split('@')[0]);

            if (!targetNum) {
                const pending = Object.values(db.pending);
                if (!pending.length) return reply(fmt('📋 No pending lend requests.'));
                const list = pending.map((r, i) =>
                    `${i+1}. *${r.requestorName}* (+${r.requestorNum}) → for +${r.targetNumber}`
                ).join('\n');
                return reply(fmt(`📋 *Pending Requests:*\n\n${list}\n\n_Use:_ \`.approvelend <requestor_number>\``));
            }

            // Find by requestor number or target number
            let record = db.pending[targetNum];
            if (!record) {
                // Try to find by target number
                record = Object.values(db.pending).find(r => r.targetNumber === targetNum);
            }

            if (!record) {
                return reply(fmt(`⚠️ No pending request found for +${targetNum}.`));
            }

            await reply(fmt(`⏳ Approved! Fetching pair code for +${record.targetNumber}…`));

            try {
                const code = await fetchPairCode(record.targetNumber);
                const formatted = code.length === 8
                    ? `${code.slice(0, 4)}-${code.slice(4)}`
                    : code;

                // Move to approved
                record.approvedAt = Date.now();
                record.code       = code;
                db.approved[record.requestorNum] = record;
                delete db.pending[record.requestorNum];
                save(db);

                // Notify the requestor in DM
                const requestorJid = `${record.requestorNum}@s.whatsapp.net`;
                await sock.sendMessage(requestorJid, {
                    text: fmt(
                        `✅ *Your Lend Request Was Approved!*\n\n` +
                        `📞 *Number:* +${record.targetNumber}\n` +
                        `🔑 *Pair Code:*\n\n` +
                        `┌──────────────┐\n` +
                        `│  \`${formatted}\`  │\n` +
                        `└──────────────┘\n\n` +
                        `*How to link:*\n` +
                        `1️⃣ Open WhatsApp → *Linked Devices*\n` +
                        `2️⃣ Tap *Link with phone number*\n` +
                        `3️⃣ Enter the code above\n\n` +
                        `⚠️ _Code expires in ~60 seconds — enter it immediately!_\n\n` +
                        `🌐 More at: ${SESSION_SERVER}\n` +
                        `_Thank you for using Silva MD!_`
                    )
                });

                await reply(fmt(
                    `✅ *Approved!*\n\n` +
                    `Pair code sent to *${record.requestorName}* (+${record.requestorNum}).\n` +
                    `Code: \`${formatted}\``
                ));

            } catch (err) {
                reply(fmt(`❌ Failed to fetch pair code: ${err.message}\n\nTry manually: \`.getcode ${record.targetNumber}\``));
            }
            return;
        }

        // ── .rejectlend — owner only ──────────────────────────────────────
        if (rawCmd === 'rejectlend') {
            if (!isOwner) return reply(fmt('⛔ Only the owner can reject lend requests.'));
            const targetNum = args.join('').replace(/\D/g, '');
            let record = db.pending[targetNum]
                      || Object.values(db.pending).find(r => r.targetNumber === targetNum);
            if (!record) return reply(fmt(`⚠️ No pending request found for +${targetNum}.`));

            record.rejectedAt = Date.now();
            db.rejected[record.requestorNum] = record;
            delete db.pending[record.requestorNum];
            save(db);

            // Notify requestor
            const requestorJid = `${record.requestorNum}@s.whatsapp.net`;
            try {
                await sock.sendMessage(requestorJid, {
                    text: fmt(
                        `❌ *Lend Request Rejected*\n\n` +
                        `Your request for +${record.targetNumber} was not approved.\n\n` +
                        `You may contact the bot owner for more information.`
                    )
                });
            } catch { /* ignore if DM fails */ }

            return reply(fmt(`❌ Request from *${record.requestorName}* (+${record.requestorNum}) rejected.`));
        }

        // ── .revokelend — owner only ──────────────────────────────────────
        if (rawCmd === 'revokelend') {
            if (!isOwner) return reply(fmt('⛔ Only the owner can revoke lends.'));
            const targetNum = args.join('').replace(/\D/g, '');
            if (db.approved[targetNum]) {
                delete db.approved[targetNum];
                save(db);
                return reply(fmt(`✅ Lend for +${targetNum} revoked.`));
            }
            return reply(fmt(`⚠️ No active lend found for +${targetNum}.`));
        }

        // ── .lend — request to lend bot ───────────────────────────────────
        if (rawCmd === 'lend') {
            const rawNumber = args.join('').replace(/\D/g, '');

            if (!rawNumber) {
                return reply(fmt(
                    `🤝 *Bot Lend / Session Request*\n\n` +
                    `Request the owner to generate a WhatsApp pair code so you can connect your own bot instance.\n\n` +
                    `*Usage:*\n` +
                    `\`.lend 2547XXXXXXXX\`\n` +
                    `_(the number you want to connect as a bot)_\n\n` +
                    `*Process:*\n` +
                    `1️⃣ Send \`.lend <your number>\`\n` +
                    `2️⃣ Owner reviews your request\n` +
                    `3️⃣ If approved, bot sends you a pair code\n` +
                    `4️⃣ Enter the code in WhatsApp → Linked Devices\n\n` +
                    `_Use \`.lendstatus\` to check your request._`
                ));
            }

            // Check if already pending or approved
            if (db.pending[senderNum]) {
                return reply(fmt(
                    `⏳ *You already have a pending request.*\n\n` +
                    `For number: +${db.pending[senderNum].targetNumber}\n` +
                    `Waiting for owner approval.\n\n` +
                    `_Use \`.lendstatus\` to check._`
                ));
            }
            if (db.approved[senderNum]) {
                return reply(fmt(
                    `✅ *You already have an approved lend.*\n\n` +
                    `For number: +${db.approved[senderNum].targetNumber}\n\n` +
                    `Contact the owner to get a fresh pair code.`
                ));
            }

            // Create request record
            const record = {
                requestorJid:  sender,
                requestorNum:  senderNum,
                requestorName: pushName,
                targetNumber:  rawNumber,
                requestedAt:   Date.now(),
                chatJid:       jid,
            };
            db.pending[senderNum] = record;
            save(db);

            // Notify owner
            try {
                await sock.sendMessage(ownerJid, {
                    text: fmt(
                        `🤝 *New Bot Lend Request*\n\n` +
                        `👤 *From:* ${pushName} (+${senderNum})\n` +
                        `📞 *For number:* +${rawNumber}\n` +
                        `🕐 *Time:* ${new Date().toLocaleString()}\n\n` +
                        `*Actions:*\n` +
                        `✅ Approve: \`.approvelend ${senderNum}\`\n` +
                        `❌ Reject:  \`.rejectlend ${senderNum}\`\n\n` +
                        `_Use \`.lendlist\` to see all requests._`
                    )
                });
            } catch { /* owner DM may fail silently */ }

            return reply(fmt(
                `✅ *Lend Request Submitted!*\n\n` +
                `📞 Number: +${rawNumber}\n` +
                `⏳ Status: *Pending owner approval*\n\n` +
                `You'll receive a pair code in your DM once approved.\n` +
                `_Use \`.lendstatus\` to track your request._`
            ));
        }
    }
};
