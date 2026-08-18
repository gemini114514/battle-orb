import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reservePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
});
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
const waitHealth = async () => { for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('测试服务器未启动'); };
const model = {
    schema: 'vibe-combat-model/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true, contactPairs: [['hero', 'enemy']], title: '自动战斗交接测试', location: '测试场',
    battlefield: { shape: 'circle', name: '圆形广场', radiusMeters: 12, center: { x: 0, y: 0 } },
    assetProfiles: [],
    combatants: [
        { id: 'hero', declarationId: 'hero', name: '主角', side: 'player', controller: 'player', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, combatProvenance: { source: 'combat-ai-derived', worldLifeLevel: 'Ⅰ', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, formulaVersion: 'v3.2.6' }, assetBindings: [], hp: 100, maxHp: 100, ep: 3, maxEp: 3, attack: 20, magicAttack: 0, attackModifier: 1, defenseDC: 50, initiativeDC: 10, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: -5, y: 0 }, facingDegrees: 0, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'squad', groupId: 'heroes', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 18 }, abilities: [{ id: 'basic-attack', name: '挥砍', type: 'physical', actionType: 'main', power: 10, modifier: 1, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
        { id: 'enemy', declarationId: 'enemy', name: '掠夺者', side: 'enemy', controller: 'ai', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, combatProvenance: { source: 'combat-ai-derived', worldLifeLevel: 'Ⅰ', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, formulaVersion: 'v3.2.6' }, assetBindings: [], hp: 30, maxHp: 30, ep: 0, maxEp: 0, attack: 5, magicAttack: 0, attackModifier: 0, defenseDC: 50, initiativeDC: 10, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: 5, y: 0 }, facingDegrees: 180, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'raiders', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 }, abilities: [{ id: 'basic-attack', name: '刺击', type: 'physical', actionType: 'main', power: 5, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
    ],
};
let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let modelCalls = 0;
    let combatCreatePayload = null;
    page.on('request', request => {
        if (request.method() !== 'POST' || !request.url().endsWith('/api/combat/sessions')) return;
        try { combatCreatePayload = request.postDataJSON(); } catch { /* diagnostics only */ }
    });
    await page.route('**/api/chat', async route => {
        modelCalls += 1;
        // Return the same model shape while reflecting the authoritative asset
        // list supplied by the real browser pipeline.  This makes the test
        // catch the former empty assetBindings regression instead of merely
        // testing a hand-written model fixture.
        const request = route.request().postDataJSON();
        const context = JSON.parse(request.messages?.at(-1)?.content || '{}');
        const reply = structuredClone(model);
        const requiredAssets = Array.isArray(context.requiredAssets) ? context.requiredAssets : [];
        reply.assetProfiles = requiredAssets.map(asset => ({ ...asset, combat: { minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, attackStyle: 'melee' } }));
        reply.combatants[0].assetBindings = requiredAssets.map(asset => String(asset.assetId));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 } }) });
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const connection = { id: 'combat-handoff-test', name: 'Combat handoff test', protocol: 'openai-chat', baseUrl: origin, path: '/api/chat', model: 'test-model', temperature: .7, maxTokens: 30000, apiKey: '' };
    await page.evaluate(connectionValue => { const app = window.__reincarnationApp; app.store.data.connections = [connectionValue]; app.store.data.settings.activeConnectionId = connectionValue.id; app.store.data.settings.aiAssignments = { storyConnectionId: connectionValue.id, combatConnectionId: connectionValue.id, shopConnectionId: connectionValue.id }; app.store.save(); }, connection);
    await page.evaluate(async () => {
        const app = window.__reincarnationApp;
        const qualities = { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' };
        await app.runtime.replaceVariables({ stat_data: { 主角: {
            姓名: '主角', 层级: 'Ⅰ', HP: 100, HP_MAX: 100, EP: 3, EP_MAX: 3,
            装备: { 测试矛: { 状态: 1, 名称: '测试矛', 战斗资产ID: 'asset-test-spear', 原始属性: { ATK: 20 }, 真属性: { ATK: 20, MATK: 0 } } }, 道具: {}, 技能: {},
            最终属性: { 武器: { 测试矛: { ATK: 20, MATK: 0 } }, 防御DC: 50, 先攻DC: 10, 物理减伤率: 0, 魔法减伤率: 0, 五维品质: qualities, 力量修正: 1, 敏捷修正: 0, 体质修正: 0, 精神修正: 0, 魅力修正: 0 },
        }, 世界: {}, 设置: {}, 系统状态: {}, 关系列表: {} } });
    });
    const declaration = { schema: 'vibe-combat-declaration/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true, contactPairs: [['hero', 'enemy']], reason: '狭路相逢', battlefield: { kind: '空旷广场', shapeHint: 'circle', description: '敌人在正前方' }, participants: [{ id: 'hero', name: '主角', side: 'player', source: 'existing', reference: '主角', state: '持剑警戒', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, relativePosition: '中心' }, { id: 'enemy', name: '掠夺者', side: 'enemy', source: 'create', state: '持刀逼近', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, relativePosition: '前方十米' }] };
    await page.evaluate(async declarationValue => window.__reincarnationApp.processBattleDeclaration({ id: 'auto-handoff', content: `<BattleDeclaration>${JSON.stringify(declarationValue)}</BattleDeclaration><BattleHandoff>LOCAL_COMBAT_REQUIRED</BattleHandoff>` }, { protocolHandoff: { status: 'LOCAL_COMBAT_REQUIRED' } }), declaration);
    assert.equal(modelCalls, 1);
    assert.equal(await page.locator('#view-combat').evaluate(node => node.classList.contains('active')), true, '正文战场声明后未切换到战术终端');
    assert.equal(await page.locator('#textEditorDialog[open]').count(), 0, '自动交接不应被声明预览编辑器阻塞');
    // A successful step-2 model now hands off immediately to step 3 so the
    // player can choose per-unit tactics/control before initiative starts.
    assert.equal(await page.locator('[data-combat-flow-step="deploy"]').evaluate(node => node.classList.contains('active')), true, '建模成功后未自动进入第3步编制部署');
    assert.equal(await page.locator('#combatStatus').textContent(), '待开始');
    assert.equal(await page.locator('#combatMap').isVisible(), false, '第3步尚未开始时不应提前进入二维战场');
    await page.locator('[data-action="combat-start"]').first().click();
    await page.locator('#combatMap').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.__reincarnationApp.getCombatState()?.status === 'paused');
    assert.equal(await page.locator('#combatStatus').textContent(), '已暂停');
    assert.ok(combatCreatePayload, '自动交接没有提交本地战斗创建请求');
    const createdPlayer = combatCreatePayload.encounter.combatants.find(unit => unit.side === 'player');
    const profileIds = combatCreatePayload.assetProfiles.map(profile => String(profile.assetId));
    assert.deepEqual(profileIds, ['asset-test-spear']);
    assert.deepEqual(createdPlayer.assetBindings, profileIds, '装备的唯一战斗资产没有写入玩家单位');
    assert.equal(createdPlayer.declarationId, 'hero');
    const persistedPlayer = (await page.evaluate(() => window.__reincarnationApp.getCombatState())).combatants.find(unit => unit.side === 'player');
    assert.deepEqual(persistedPlayer.assetBindings, profileIds, '本地归一化后丢失玩家装备绑定');
    assert.equal(persistedPlayer.lifeLevel, 'Ⅰ');
    assert.deepEqual(persistedPlayer.attributeQualities, createdPlayer.attributeQualities);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, modelCalls, activePanel: await page.locator('#view-combat').evaluate(node => node.classList.contains('active')), status: await page.locator('#combatStatus').textContent(), pageErrors: errors }, null, 2));
} finally { await browser?.close(); server.kill(); }
