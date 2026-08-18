import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const sourcePath = 'C:/Users/fengx/Downloads/Izumi 0503-RP用.json';
const raw = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const normalized = normalizePreset(raw, 'Izumi 0503-RP用.json');
const absent = normalized.prompts.filter(prompt => prompt.enabled && !raw.prompt_order[0].order.some(item => item.identifier === prompt.identifier));
if (absent.length) throw new Error(`prompt_order allow-list 泄漏：${absent.map(item => item.name).join(', ')}`);

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const result = await page.evaluate(preset => {
        const app = window.__reincarnationApp;
        app.runtime.setPreset(preset);
        const prompt = app.runtime.buildPrompt([{ role: 'assistant', content: '【开局】' }]);
        return {
            roles: prompt.messages.map(message => message.role),
            systemCount: prompt.messages.filter(message => message.role === 'system').length,
            systemChars: prompt.messages.filter(message => message.role === 'system').reduce((sum, message) => sum + message.content.length, 0),
            first: prompt.messages.slice(0, 3).map(message => ({ role: message.role, content: message.content.slice(0, 80) })),
        };
    }, normalized);
    console.log(JSON.stringify({ absent: absent.map(item => item.name), result, pageErrors }, null, 2));
    // The trace baseline's main system block is 382 characters.  A squashed
    // prompt must retain one system anchor and never end in system.
    if (pageErrors.length || result.systemCount !== 1 || result.systemChars !== 382 || result.roles.at(-1) === 'system') process.exitCode = 1;
} finally {
    await browser.close();
}
