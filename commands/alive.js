const settings = require("../settings");
const { sendConfiguredPromoMessage } = require('../lib/dashboardPromos')

async function aliveCommand(sock, chatId, message) {
    try {
        const botName = settings.botName || 'Knight Bot'
        const modeLabel = settings.commandMode === 'private' ? 'Private' : 'Public'
        const fallbackMessage = `*🤖 ${botName} is Active!*\n\n` +
            `*Version:* ${settings.version}\n` +
            `*Status:* Online\n` +
            `*Mode:* ${modeLabel}\n\n` +
            `*🌟 Features:*\n` +
            `• Group Management\n` +
            `• Antilink Protection\n` +
            `• Fun Commands\n` +
            `• And more!\n\n` +
            `Type *.menu* for full command list`

        await sendConfiguredPromoMessage(sock, chatId, settings, {
            textKey: 'aliveMessage',
            mediaKey: 'aliveMediaUrl',
            buttonsKey: 'aliveButtons',
            fallbackText: fallbackMessage,
            replacements: {
                botName,
                version: settings.version || '3.0.0',
                mode: modeLabel,
                owner: settings.botOwner || 'Owner',
            },
            quoted: message,
        })
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { text: 'Bot is alive and running!' }, { quoted: message });
    }
}

module.exports = aliveCommand;