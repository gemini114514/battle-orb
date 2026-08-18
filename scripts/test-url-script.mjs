import { chromium } from 'playwright-core';

const sourceUrl = 'https://testingcf.jsdelivr.net/gh/sanmingyue/tavern_dist@cp-v2.1.0/dist/潮汐预设脚本/index.js';
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.locator('[data-panel="settings"]').first().click();
    await page.locator('[data-settings-tab="scripts"]').click();
    await page.locator('#scriptUrl').fill(sourceUrl);
    await page.locator('[data-action="import-script-url"]').click();
    await page.getByText('潮汐预设脚本', { exact: true }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(8000);
    await page.locator('.chaoxi-fab').click();
    await page.waitForTimeout(500);
    await page.getByText('预设仓库', { exact: true }).click();
    const mayaCard = page.locator('.chaoxi-store-card').filter({ hasText: '明月秋青 Maya' });
    await mayaCard.waitFor({ state: 'visible' });
    await mayaCard.getByRole('button', { name: /导入预设/ }).click();
    await page.locator('.chaoxi-modal').getByRole('button', { name: /确定|确认/ }).click();
    await page.waitForFunction(() => window.getPresetNames?.().includes('明月秋青Maya'), null, { timeout: 30000 });
    const result = await page.evaluate(() => {
        const frame = document.querySelector('iframe[data-assistant-script]');
        const hostNodes = [...document.querySelectorAll('[script_id]')];
        return {
            imported: Boolean(frame), frameHidden: Boolean(frame?.hidden),
            hostNodeCount: hostNodes.length,
            floatingCandidates: [...document.querySelectorAll('button,div')].filter(node => /chaoxi|tidal|floating|float|fab|悬浮/i.test(String(node.className || '') + String(node.id || ''))).slice(0, 20).map(node => `${node.tagName}.${node.className}#${node.id}`),
            panelVisible: [...document.querySelectorAll('[class*="chaoxi"]')].some(node => /panel|dialog|window/i.test(String(node.className || '')) && getComputedStyle(node).display !== 'none'),
            mayaImported: window.getPresetNames?.().includes('明月秋青Maya'),
            mayaPrompts: window.getPreset?.('明月秋青Maya')?.prompts?.length,
            bodyText: document.body.innerText.slice(-500),
        };
    });
    console.log({ ...result, pageErrors: errors.slice(0, 10) });
    if (!result.imported || !result.frameHidden || !result.hostNodeCount || !result.panelVisible || !result.mayaImported || result.mayaPrompts !== 165 || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
