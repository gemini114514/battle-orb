import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = 'http://127.0.0.1:4174';
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let chatCalls = 0;
    await page.route('**/api/chat', async route => {
        chatCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 450));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '这是一次战斗融合测试剧情。' } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) });
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);

    const connection = { id: 'narration-test', name: 'Narration test', protocol: 'openai-chat', baseUrl: origin, path: '/api/chat', model: 'narration-test-model', temperature: 0.7, maxTokens: 30000, apiKey: '' };
    const unit = (id, name, side, position, hp, attackModifier, initiativeDC) => ({
        id, name, side, controller: side === 'player' ? 'player' : 'ai', hp, maxHp: hp, ep: side === 'player' ? 3 : 0, maxEp: side === 'player' ? 3 : 0,
        attack: side === 'player' ? 20 : 1, magicAttack: 0, attackModifier, defenseDC: 50, initiativeDC, armor: 0, resistance: 0,
        position, zoneId: 'arena', abilities: [{ id: side === 'player' ? 'basic-attack' : 'enemy-hit', name: side === 'player' ? '基础攻击' : '敌方攻击', type: 'physical', actionType: 'main', power: side === 'player' ? 20 : 1, modifier: attackModifier, epCost: 0, minRangeMeters: 0, maxRangeMeters: 2, targetCount: 1, aoe: false }],
    });
    const encounter = {
        seed: 'narration-fixed', mode: 'manual', encounter: {
            title: '叙事写入状态测试', battlefield: { shape: 'rectangle', widthMeters: 20, heightMeters: 12, center: { x: 0, y: 0 } },
            zones: [{ id: 'arena', name: '测试场', adjacent: [], capacity: 4 }],
            combatants: [unit('hero', '测试主角', 'player', { x: -1, y: 0 }, 100, 100, 1000), unit('enemy', '测试敌人', 'enemy', { x: 1, y: 0 }, 20, -100, -100)],
        },
    };
    await page.evaluate(async ({ connection, encounter, origin }) => {
        const app = window.__reincarnationApp;
        app.store.data.connections = [connection];
        app.store.data.settings.activeConnectionId = connection.id;
        app.store.data.settings.aiAssignments = { storyConnectionId: connection.id, combatConnectionId: connection.id, shopConnectionId: connection.id };
        app.store.save();
        const response = await fetch(`${origin}/api/combat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(encounter) });
        const battle = await response.json();
        const started = await fetch(`${origin}/api/combat/${battle.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }) });
        if (!started.ok) throw new Error(await started.text());
        app.store.activeSession.activeBattleId = battle.id;
        app.store.activeSession.combatIds = [battle.id];
        app.store.save();
    }, { connection, encounter, origin });

    // The mobile bottom rail intentionally sits outside the document flow on
    // narrow screenshots; dispatch through the real delegated handler instead
    // of making the browser scroll the page to reach the fixed control.
    await page.evaluate(() => document.querySelector('[data-panel="combat"]')?.click());
    await page.waitForTimeout(1500);
    await page.locator('#combatNarrateButton').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#combatStatus')?.textContent.includes('已暂停'));
    const beforeMessages = await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.length);
    await page.evaluate(() => document.querySelector('#combatNarrateButton')?.click());
    await page.waitForFunction(() => document.querySelector('#combatNarrateButton')?.dataset.narrationState === 'running');
    assert.equal(await page.locator('#combatNarrateButton').isDisabled(), true);
    await page.evaluate(() => document.querySelector('#combatNarrateButton')?.click());
    await page.waitForFunction(() => document.querySelector('#combatNarrateButton')?.dataset.narrationState === 'success');
    assert.equal(chatCalls, 1);
    assert.equal((await page.locator('#combatNarrateButton').textContent()).trim(), '已写入当前剧情');
    assert.equal(await page.locator('#combatNarrateButton').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.length), beforeMessages + 1);
    assert.ok(await page.getByText('这是一次战斗融合测试剧情。', { exact: true }).count() >= 1);
    assert.equal(await page.evaluate(() => window.__reincarnationApp.getCombatState()), null, '剧情写回成功后应清理当前二维战场临时状态');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, chatCalls, beforeMessages, afterMessages: beforeMessages + 1, button: (await page.locator('#combatNarrateButton').textContent()).trim(), pageErrors: errors }, null, 2));
} finally {
    await browser.close();
}
