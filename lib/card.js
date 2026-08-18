import fs from 'node:fs';
import extractChunks from 'png-chunks-extract';
import textChunk from 'png-chunk-text';

export function readCharacterCard(filePath) {
    const chunks = extractChunks(fs.readFileSync(filePath));
    const payloads = chunks
        .filter(chunk => chunk.name === 'tEXt')
        .map(chunk => textChunk.decode(chunk.data))
        .filter(chunk => chunk.keyword === 'chara' || chunk.keyword === 'ccv3');

    if (!payloads.length) throw new Error('角色卡 PNG 中没有 chara/ccv3 数据');
    const parsed = JSON.parse(Buffer.from(payloads[0].text, 'base64').toString('utf8'));
    return parsed;
}
