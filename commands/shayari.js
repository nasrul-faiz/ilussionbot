const fetch = require('node-fetch');
const { sendInteractiveButtons } = require('../lib/interactiveButtons');

async function shayariCommand(sock, chatId, message) {
    try {
        const response = await fetch('https://shizoapi.onrender.com/api/texts/shayari?apikey=shizo');
        const data = await response.json();
        
        if (!data || !data.result) {
            throw new Error('Invalid response from API');
        }

        await sendInteractiveButtons(sock, chatId, {
            text: data.result,
            nativeButtons: [
                {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'Shayari 🪄',
                        id: '.shayari'
                    })
                },
                {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: '🌹 RoseDay',
                        id: '.roseday'
                    })
                }
            ]
        }, { quoted: message });
    } catch (error) {
        console.error('Error in shayari command:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Failed to fetch shayari. Please try again later.',
        }, { quoted: message });
    }
}

module.exports = { shayariCommand }; 