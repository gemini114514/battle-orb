import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCharacterCard } from '../lib/card.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const card = readCharacterCard(path.join(root, 'card', 'V3.2.6.png'));
const data = card.data ?? card;
const report = {
    spec: `${card.spec} ${card.spec_version}`,
    name: data.name,
    worldbook: data.character_book?.entries?.length ?? 0,
    regex: data.extensions?.regex_scripts?.length ?? 0,
    scripts: (data.extensions?.tavern_helper?.scripts ?? []).map(item => item.name),
};
console.log(report);
if (report.worldbook !== 41 || report.regex !== 12 || report.scripts.length !== 4) process.exit(1);
