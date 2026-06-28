const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const webp = require('node-webpmux');
const crypto = require('crypto');

const TMP_DIR = path.join(process.cwd(), 'tmp');
const MAX_STICKER_SIZE = 1000 * 1024;

function ensureTempDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function buildExif(packname, emojis) {
  const json = {
    'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
    'sticker-pack-name': packname || 'KnightBot',
    'sticker-pack-publisher': packname || 'KnightBot',
    'emojis': emojis || ['🤖']
  };

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2A, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00
  ]);

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  return exif;
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { shell: '/bin/bash' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function getMediaObject(message, chatId) {
  const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted) {
    const quotedInfo = message.message.extendedTextMessage.contextInfo;
    return {
      key: {
        remoteJid: chatId,
        id: quotedInfo.stanzaId,
        participant: quotedInfo.participant
      },
      message: quoted
    };
  }
  return message;
}

function isWebpAnimated(buffer) {
  return buffer.indexOf(Buffer.from('ANIM')) !== -1;
}

function getExtension(mimetype) {
  if (!mimetype) return 'bin';
  if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return 'jpg';
  if (mimetype.includes('png')) return 'png';
  if (mimetype.includes('webp')) return 'webp';
  if (mimetype.includes('gif')) return 'gif';
  if (mimetype.includes('mp4')) return 'mp4';
  if (mimetype.includes('mov')) return 'mov';
  if (mimetype.includes('avi')) return 'avi';
  return 'bin';
}

function getMediaMessage(message) {
  return message.message?.imageMessage || message.message?.videoMessage || message.message?.stickerMessage || message.message?.documentMessage;
}

async function convertToWebp(inputPath, outputPath, options) {
  const { animated, attempt } = options;
  const fps = animated ? (attempt > 1 ? 10 : 15) : 1;
  const quality = animated ? (attempt > 1 ? 40 : 70) : 75;
  const scale = attempt > 2 ? 320 : 512;
  const duration = animated ? (attempt > 1 ? 4 : 6) : null;
  const bitrate = animated ? (attempt > 1 ? '120k' : '180k') : null;

  const filters = animated
    ? `scale=${scale}:${scale}:force_original_aspect_ratio=decrease,fps=${fps},pad=${scale}:${scale}:(ow-iw)/2:(oh-ih)/2:color=#00000000`
    : `scale=${scale}:${scale}:force_original_aspect_ratio=decrease,format=rgba,pad=${scale}:${scale}:(ow-iw)/2:(oh-ih)/2:color=#00000000`;

  let cmd = `ffmpeg -y -i "${inputPath}" -vf "${filters}" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality ${quality} -compression_level 6 "${outputPath}"`;

  if (animated) {
    cmd = `ffmpeg -y -i "${inputPath}" ${duration ? `-t ${duration}` : ''} -vf "${filters}" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality ${quality} -compression_level 6 -b:v ${bitrate} -max_muxing_queue_size 1024 "${outputPath}"`;
  }

  await runCommand(cmd);
}

async function encodeSticker(mediaBuffer, mimetype, isAnimated) {
  ensureTempDir();
  const extension = getExtension(mimetype);
  const inputPath = path.join(TMP_DIR, `sticker_input_${Date.now()}.${extension}`);
  const outputPath = path.join(TMP_DIR, `sticker_output_${Date.now()}.webp`);

  fs.writeFileSync(inputPath, mediaBuffer);

  let finalBuffer = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await convertToWebp(inputPath, outputPath, { animated: isAnimated, attempt });
      if (!fs.existsSync(outputPath)) throw new Error('FFmpeg did not create a sticker file');

      const currentBuffer = fs.readFileSync(outputPath);
      if (currentBuffer.length <= MAX_STICKER_SIZE || attempt === 3) {
        finalBuffer = currentBuffer;
        break;
      }

      lastError = new Error('Sticker too large for WhatsApp, retrying smaller output');
    } catch (err) {
      lastError = err;
      if (attempt === 3) throw err;
    }
  }

  try { fs.unlinkSync(inputPath); } catch (e) {}
  try { fs.unlinkSync(outputPath); } catch (e) {}

  if (!finalBuffer) throw lastError || new Error('Failed to generate sticker');
  return finalBuffer;
}

async function applyExif(webpBuffer) {
  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = buildExif(settings.packname || 'KnightBot', ['🤖']);
  return await img.save(null);
}

async function stickerCommand(sock, chatId, message) {
  const messageToQuote = message;
  const targetMessage = getMediaObject(message, chatId);
  const mediaMessage = getMediaMessage(targetMessage);

  if (!mediaMessage) {
    await sock.sendMessage(chatId, {
      text: 'Please reply to an image/video/sticker with .sticker, or send an image/video with .sticker as the caption.',
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: '120363161513685998@newsletter',
          newsletterName: 'KnightBot MD',
          serverMessageId: -1
        }
      }
    }, { quoted: messageToQuote });
    return;
  }

  try {
    const mediaBuffer = await downloadMediaMessage(targetMessage, 'buffer', {}, {
      logger: undefined,
      reuploadRequest: sock.updateMediaMessage
    });

    if (!mediaBuffer) {
      await sock.sendMessage(chatId, {
        text: 'Failed to download media. Please try again.',
        contextInfo: {
          forwardingScore: 999,
          isForwarded: true,
          forwardedNewsletterMessageInfo: {
            newsletterJid: '120363161513685998@newsletter',
            newsletterName: 'KnightBot MD',
            serverMessageId: -1
          }
        }
      }, { quoted: messageToQuote });
      return;
    }

    const mimetype = mediaMessage.mimetype || '';
    const isAnimated = mimetype.includes('gif') || mimetype.includes('video') || mimetype === 'image/webp' && isWebpAnimated(mediaBuffer);

    let webpBuffer = await encodeSticker(mediaBuffer, mimetype, isAnimated);
    webpBuffer = await applyExif(webpBuffer);

    if (webpBuffer.length > MAX_STICKER_SIZE) {
      console.warn(`Sticker size is ${Math.round(webpBuffer.length / 1024)}KB, which is above the recommended WhatsApp limit.`);
    }

    await sock.sendMessage(chatId, {
      sticker: webpBuffer
    }, { quoted: messageToQuote });
  } catch (error) {
    console.error('Error in sticker command:', error);
    await sock.sendMessage(chatId, {
      text: 'Failed to create sticker! Try again later.',
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: '120363161513685998@newsletter',
          newsletterName: 'KnightBot MD',
          serverMessageId: -1
        }
      }
    }, { quoted: messageToQuote });
  }
}

module.exports = stickerCommand;
