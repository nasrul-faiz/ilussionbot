const settings = require('../settings');
const { sendInteractiveButtons } = require('../lib/interactiveButtons');

async function twilioCommand(sock, chatId, message) {
    await sendInteractiveButtons(sock, chatId, {
        text: `Hello! I am ${settings.botName}. Choose an option below to get started.\n\nRepo: https://github.com/gatotkacabatu999-lab/Knightbot-MD\nOwner: +${settings.ownerNumber}`,
        footer: `${settings.botName} • by ${settings.botOwner}`,
        nativeButtons: [
            {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: '🌐 Open Repo',
                    id: '.github'
                })
            },
            {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: '📞 Owner',
                    id: '.owner'
                })
            },
            {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: '💬 Get Help',
                    id: '.help'
                })
            }
        ]
    }, { quoted: message });
}

module.exports = twilioCommand;
