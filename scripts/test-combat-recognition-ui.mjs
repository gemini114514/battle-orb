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
const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, REINCARNATION_PORT: String(port) },
});
const waitHealth = async () => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* startup race */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器未启动');
};

const qualities = { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' };
const declaration = {
    schema: 'vibe-combat-declaration/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true,
    contactPairs: [['hero', 'enemy']], reason: '测试页面快捷识别',
    battlefield: { kind: '走廊', shapeHint: 'rectangle', description: '已经互相看见的狭长走廊' },
    participants: [
        { id: 'hero', name: '主角', side: 'player', source: 'existing', reference: '主角', state: '持械警戒', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '中心' },
        { id: 'enemy', name: '测试敌人', side: 'enemy', source: 'create', state: '正面接触', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '前方' },
    ],
};

let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let modelCalls = 0;
    await page.route('**/api/chat', async route => {
        modelCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 1250));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(declaration) } }], usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } }),
        });
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const connection = { id: 'recognition-test', name: 'Recognition test', protocol: 'openai-chat', baseUrl: origin, path: '/api/chat', model: 'test-model', temperature: .7, maxTokens: 30000, apiKey: '' };
    await page.evaluate(async connectionValue => {
        const app = window.__reincarnationApp;
        app.store.data.connections = [connectionValue];
        app.store.data.settings.activeConnectionId = connectionValue.id;
        app.store.data.settings.aiAssignments = { storyConnectionId: connectionValue.id, combatConnectionId: connectionValue.id, shopConnectionId: connectionValue.id };
        app.store.save();
        await app.runtime.replaceVariables({ stat_data: { 主角: { 姓名: '主角', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 0, EP_MAX: 0, 最终属性: { 五维品质: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' } } }, 世界: {}, 设置: {}, 系统状态: {}, 关系列表: {} } });
        app.renderAll();
    }, connection);
    await page.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await page.evaluate(() => document.querySelector('[data-action="toggle-actions"]')?.click());
    const quick = page.locator('.quick-action-card[data-action="combat-draft-ai"]');
    await quick.waitFor({ state: 'visible' });
    assert.equal(await quick.count(), 1, '剧情快捷回复缺少 AI 识别当前遭遇');
    await quick.click();
    await page.locator('#combatDraftAiButton[data-recognition-state="running"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#combatDraftAiButton').getAttribute('aria-busy'), 'true');
    assert.match(await page.locator('#combatDraftAiStatus').textContent(), /战斗 AI 识别中/);
    assert.equal(await page.locator('#aiProcessBar:not(.hidden)').count(), 1, '大模型运行时应显示全局计时条');
    assert.match(await page.locator('#aiProcessBar').textContent(), /战斗 AI/);
    await page.waitForFunction(() => document.querySelector('#combatDraftAiButton')?.getAttribute('data-recognition-state') === 'success', null, { timeout: 10000 });
    assert.equal(await page.locator('#combatDraftAiButton').getAttribute('aria-busy'), 'false');
    assert.match(await page.locator('#combatDraftAiStatus').textContent(), /识别完成/);
    assert.equal(await page.locator('#aiProcessBar:not(.hidden)').count(), 0, '请求结束后全局计时条应收起');
    assert.equal(await page.locator('#textEditorDialog[open]').count(), 1, '识别成功后应打开 BattleDeclaration 确认编辑器');
    assert.equal(modelCalls, 1);
    const parserCases = await page.evaluate(value => {
        const app = window.__reincarnationApp;
        const cases = [
            ['raw', JSON.stringify(value)],
            ['tagged', `<BattleDeclaration>${JSON.stringify(value)}</BattleDeclaration>`],
            ['envelope', JSON.stringify({ BattleDeclaration: value })],
            ['prefixed-json', `收到声明：${JSON.stringify(value)}\n以上。`],
        ];
        return cases.map(([name, content]) => {
            try {
                const parsed = app.parseBattleDeclarationResponse(content);
                return { name, ok: parsed.declaration?.reason === value.reason, source: parsed.source, path: parsed.path };
            } catch (error) { return { name, ok: false, error: error.message }; }
        });
    }, declaration);
    assert.deepEqual(parserCases.map(item => item.ok), [true, true, true, true], `识别响应包装解析失败：${JSON.stringify(parserCases)}`);
    assert.deepEqual(errors, []);
    const screenshot = path.join(root, '.test', 'combat-recognition-ui.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(JSON.stringify({ ok: true, modelCalls, recognitionState: await page.locator('#combatDraftAiButton').getAttribute('data-recognition-state'), status: await page.locator('#combatDraftAiStatus').textContent(), screenshot, pageErrors: errors }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
