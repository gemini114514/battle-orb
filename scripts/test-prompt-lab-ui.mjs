import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reservePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(error => error ? reject(error) : resolve(port));
    });
});
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
const waitHealth = async () => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* startup race */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器未启动');
};

let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    await page.evaluate(async connection => {
        const app = window.__reincarnationApp;
        app.store.data.connections = [connection];
        app.store.data.settings.activeConnectionId = connection.id;
        app.store.data.settings.aiAssignments = { storyConnectionId: connection.id, combatConnectionId: connection.id, shopConnectionId: connection.id };
        app.store.save();
        await app.runtime.replaceVariables({ stat_data: { 主角: { 姓名: '提示词测试者', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 0, EP_MAX: 0 }, 世界: { 名称: '测试世界' }, 设置: {}, 系统状态: {}, 关系列表: {} } });
        app.renderAll();
    }, { id: 'prompt-lab-test', name: 'Prompt lab test', protocol: 'openai-chat', baseUrl: origin, path: '/api/chat', model: 'test-model', temperature: .7, maxTokens: 30000, apiKey: '' });
    await page.evaluate(() => document.querySelector('[data-panel="settings"]')?.click());
    await page.evaluate(() => document.querySelector('[data-settings-tab="prompt-lab"]')?.click());
    await page.locator('#promptLabMode').waitFor({ state: 'attached' });
    await page.locator('#promptLabPreview').waitFor({ state: 'attached' });
    let preview = await page.locator('#promptLabPreview').inputValue();
    assert.match(preview, /messages/);
    assert.match(preview, /STORY|剧情|BattleDeclaration/);
    assert.ok(await page.locator('.prompt-module-card[data-prompt-module-card="preset"]').count() === 1, '正文预览缺少预设模块');
    assert.ok(await page.locator('.prompt-module-card[data-prompt-module-card="rules"]').count() === 1, '正文预览缺少规则模块');
    assert.ok(await page.locator('.prompt-module-card[data-prompt-module-card="work"]').count() === 1, '正文预览缺少工作提示词模块');
    await page.locator('[data-prompt-module-text="rules"]').fill('这是正文规则模块测试覆盖。');
    await page.locator('[data-action="prompt-lab-save-modules"]').click();
    await page.waitForFunction(() => document.querySelector('#promptLabPreview')?.value.includes('这是正文规则模块测试覆盖。'));
    assert.equal(await page.evaluate(() => window.__reincarnationApp.store.data.settings.promptModules.story.rules.text), '这是正文规则模块测试覆盖。');

    await page.evaluate(() => { const select = document.querySelector('#promptLabMode'); select.value = 'combat-recognition'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#promptLabPreview')?.value.includes('BattleDeclaration'));
    preview = await page.locator('#promptLabPreview').inputValue();
    assert.match(preview, /当前剧情与 MVU/);
    await page.locator('[data-prompt-module-text="work"]').fill('这是遭遇识别工作模块测试覆盖。');
    await page.locator('[data-action="prompt-lab-save-modules"]').click();
    await page.waitForFunction(() => document.querySelector('#promptLabPreview')?.value.includes('这是遭遇识别工作模块测试覆盖。'));

    await page.evaluate(() => { const select = document.querySelector('#promptLabMode'); select.value = 'shop'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#promptLabPreview')?.value.includes('forge_shop') || document.querySelector('#promptLabPreview')?.value.includes('商城视野'), null, { timeout: 10000 });
    preview = await page.locator('#promptLabPreview').inputValue();
    assert.match(preview, /messages/);
    assert.match(preview, /商城视野|forge_shop/);

    await page.locator('[data-prompt-module-text="work"]').fill('这是商城工作模块测试覆盖。');
    await page.locator('[data-action="prompt-lab-save-modules"]').click();
    await page.waitForFunction(() => document.querySelector('#promptLabPreview')?.value.includes('这是商城工作模块测试覆盖。'));
    assert.equal(await page.evaluate(() => window.__reincarnationApp.store.data.settings.promptModules.shop.work.text), '这是商城工作模块测试覆盖。');

    for (const mode of ['combat-model', 'combat-strategy', 'combat-narration', 'assistant-script', 'connection-test']) {
        await page.evaluate(value => { const select = document.querySelector('#promptLabMode'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, mode);
        await page.waitForFunction(() => Boolean(document.querySelector('#promptLabPreview')?.value));
        assert.equal(await page.locator('.prompt-module-card[data-prompt-module-card="rules"]').count(), 1, `${mode} 缺少规则模块`);
        assert.equal(await page.locator('.prompt-module-card[data-prompt-module-card="work"]').count(), 1, `${mode} 缺少工作模块`);
    }

    await page.evaluate(() => { const select = document.querySelector('#promptLabMode'); select.value = 'shop'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForTimeout(180);
    await page.evaluate(() => {
        document.querySelector('#promptLabOverride').value = '这是提示词实验室测试覆盖。';
        document.querySelector('#promptLabEnabled').checked = true;
        document.querySelector('[data-action="prompt-lab-save"]').click();
    });
    await page.waitForFunction(() => document.querySelector('#promptLabPreview')?.value.includes('这是提示词实验室测试覆盖。'));
    assert.equal(await page.evaluate(() => window.__reincarnationApp.store.data.settings.promptOverrides.shop.enabled), true);
    assert.deepEqual(errors, []);
    await page.waitForTimeout(1400);
    const screenshot = path.join(root, '.test', 'prompt-lab-modules-ui.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(JSON.stringify({ ok: true, modes: ['story', 'combat-recognition', 'shop'], overrideSaved: true, screenshot, pageErrors: errors }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
