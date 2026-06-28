const fetch = require('node-fetch');
const { sendInteractiveButtons } = require('../lib/interactiveButtons');

async function memeCommand(sock, chatId, message) {
    try {
        const response = await fetch('https://shizoapi.onrender.com/api/memes/cheems?apikey=shizo');
        
        // Check if response is an image
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('image')) {
            const imageBuffer = await response.buffer();
            
            await sock.sendMessage(chatId, { 
                image: imageBuffer,
                caption: "> Here's your cheems meme! 🐕"
            },{ quoted: message});

            await sendInteractiveButtons(sock, chatId, {
                text: 'Pick your next fun command:',
                nativeButtons: [
                    {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                            display_text: '🎭 Another Meme',
                            id: '.meme'
                        })
                    },
                    {
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({
                            display_text: '😄 Joke',
                            id: '.joke'
                        })
                    }
                ]
            }, { quoted: message });
        } else {
            throw new Error('Invalid response type from API');
        }
    } catch (error) {
        console.error('Error in meme command:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Failed to fetch meme. Please try again later.'
        },{ quoted: message });
    }
}

module.exports = memeCommand;
