import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vendors the self-contained browser QuickJS bundle into combat/vendor/ so the
// Tavern extension can execute script abilities without a node_modules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'quickjs-emscripten', 'dist', 'index.global.js');
const targetDir = path.join(root, 'combat', 'vendor');
const target = path.join(targetDir, 'quickjs.global.js');

if (!fs.existsSync(source)) {
    console.error(`缺少 quickjs-emscripten 浏览器包：${source}（请先 npm install）`);
    process.exit(1);
}
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
const kb = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`quickjs.global.js 已复制（${kb}KB）`);
