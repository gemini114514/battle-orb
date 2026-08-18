import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, '.test');
fs.mkdirSync(testDir, { recursive: true });
const reservePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(error => error ? reject(error) : resolve(address.port));
    });
});
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
const waitHealth = async () => {
    for (let index = 0; index < 80; index += 1) { try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('测试服务器未启动');
};
const request = async (pathName, options = {}) => { const response = await fetch(`${origin}${pathName}`, { headers: { 'Content-Type': 'application/json' }, ...options }); const body = await response.json(); if (!response.ok) throw new Error(body.error || response.statusText); return body; };

let browser;
try {
    await waitHealth();
    const declaration = { reason: '狭路相逢', battlefield: { kind: '空旷广场', shapeHint: 'circle', description: '敌人在正前方' }, participants: [{ id: 'hero', name: '主角', side: 'player', source: 'existing', reference: '主角', state: '持剑警戒', relativePosition: '中心' }, { id: 'enemy', name: '掠夺者', side: 'enemy', source: 'create', state: '持刀逼近', relativePosition: '前方十米' }] };
    const model = { title: '二维 UI 测试', location: '广场', battlefield: { shape: 'circle', name: '圆形广场', radiusMeters: 12, center: { x: 0, y: 0 } }, assetProfiles: [], combatants: [
        { id: 'hero', declarationId: 'hero', name: '主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, ep: 3, maxEp: 3, attack: 20, magicAttack: 0, attackModifier: 100, defenseDC: 50, initiativeDC: 1000, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: -5, y: 0 }, facingDegrees: 0, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'squad', groupId: 'heroes', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 18 }, abilities: [{ id: 'basic-attack', name: '挥砍', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
        { id: 'enemy', declarationId: 'enemy', name: '掠夺者', side: 'enemy', controller: 'ai', hp: 30, maxHp: 30, ep: 0, maxEp: 0, attack: 5, magicAttack: 0, attackModifier: -100, defenseDC: 50, initiativeDC: -100, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: 5, y: 0 }, facingDegrees: 180, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'raiders', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 }, abilities: [{ id: 'basic-attack', name: '刺击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
    ] };
    const check = await request('/api/combat/model/validate', { method: 'POST', body: JSON.stringify({ declaration, model, requiredAssets: [] }) }); assert.equal(check.ok, true);
    const battle = await request('/api/combat/sessions', { method: 'POST', body: JSON.stringify({ seed: 'v2-ui', mode: 'manual', encounter: model, preparation: { declaration, attempts: 1 } }) });
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__reincarnationApp);
    // The declaration path opens a preview before any model call.
    await page.evaluate(async declarationValue => window.__reincarnationApp.processBattleDeclaration({ id: 'story-v2-declaration', content: `<BattleDeclaration>${JSON.stringify(declarationValue)}</BattleDeclaration>` }, { automatic: false, protocolHandoff: { status: 'LOCAL_COMBAT_REQUIRED' } }), declaration);
    await page.locator('#textEditorDialog[open]').waitFor(); assert.match(await page.locator('#textEditorTitle').textContent(), /战场声明/); await page.locator('[data-editor-action="close"]').last().click();
    await page.evaluate(id => { const session = window.__reincarnationApp.store.activeSession; session.activeBattleId = id; session.combatIds = [id]; window.__reincarnationApp.store.save(); }, battle.id);
    // A fresh battle (draft) lands on the guided 编制部署 step; the 2D field is
    // not shown until the battle is started.
    await page.locator('.mobile-bottom-nav [data-panel="combat"]').click();
    await page.locator('[data-combat-phase="deploy"].is-active').waitFor();
    assert.equal(await page.locator('[data-combat-phase="deploy"]').evaluate(el => el.classList.contains('is-active')), true, '加载待开始遭遇后应停留在编制部署阶段');
    assert.equal(await page.locator('#combatRoster').count(), 1, '编制部署阶段缺少参战实体面板');
    assert.equal(await page.locator('#combatStrategy').count(), 1, '编制部署阶段缺少策略编辑');
    assert.equal(await page.locator('[data-combat-unit-strategy="hero"]').count(), 1, '编制部署阶段缺少单位策略选择');
    await page.locator('[data-combat-unit-strategy="hero"]').selectOption('guerrilla');
    await page.locator('[data-combat-unit-mode="hero"]').selectOption('manual');
    await page.locator('[data-action="combat-start"]').click();
    await page.locator('#combatMap').waitFor();
    assert.equal(await page.locator('[data-combat-phase="battle"]').evaluate(el => el.classList.contains('is-active')), true, '开始后应进入战场演算阶段');
    const configuredStrategy = await page.evaluate(() => window.__reincarnationApp.getCombatState().strategy);
    assert.equal(configuredStrategy.assignments.hero.presetId, 'guerrilla', '单位策略预设没有写入本地战斗状态');
    await page.locator('#view-combat').screenshot({ path: path.join(testDir, 'combat-v2-2d-console-initial.png') });
    assert.equal(await page.locator('#combatMap').isVisible(), true, '二维战场主视图未显示');
    assert.equal(await page.locator('[data-action="combat-debug-export"]').count(), 1, '战术终端缺少 DEBUG 导出按钮');
    assert.equal(await page.locator('.combat-battle-report').count(), 1, '战术终端缺少简明攻击战报');
    assert.equal(await page.locator('.combat-ledger-audit').count(), 1, '完整裁定账本未折叠保留');
    assert.ok(await page.locator('.combat-ledger-round').count() > 0, '裁定账本未按回合分组');
    assert.ok(await page.locator('.combat-ledger-category.state').count() > 0, '裁定账本缺少状态与系统分类');
    assert.equal(await page.locator('[data-action="combat-map-zoom-200"]').count(), 1, '二维战场缺少 200% 缩放按钮');
    await page.locator('[data-action="combat-map-zoom-200"]').click();
    assert.equal(await page.locator('#combatMap').evaluate(canvas => canvas._battlefieldTransform.zoom), 2, '二维战场未进入 200% 缩放');
    await page.locator('#combatMap').scrollIntoViewIfNeeded();
    const mapBox = await page.locator('#combatMap').boundingBox();
    const beforePan = await page.locator('#combatMap').evaluate(canvas => ({ x: canvas._battlefieldTransform.originX, y: canvas._battlefieldTransform.originY }));
    await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + mapBox.width / 2 + 42, mapBox.y + mapBox.height / 2 + 18);
    await page.mouse.up();
    const afterPan = await page.locator('#combatMap').evaluate(canvas => ({ x: canvas._battlefieldTransform.originX, y: canvas._battlefieldTransform.originY }));
    assert.ok(Math.abs(afterPan.x - beforePan.x) > 20 && Math.abs(afterPan.y - beforePan.y) > 8, '二维战场放大后无法拖拽视口');
    await page.locator('[data-action="combat-map-zoom-reset"]').click();
    assert.ok(await page.locator('#combatMap').evaluate(canvas => canvas._rangeRenderState?.movementMeters > 0), '选中单位未渲染移动范围');
    assert.ok(await page.locator('#combatMap').evaluate(canvas => canvas._rangeRenderState?.attackRanges?.length > 0), '选中单位未渲染攻击范围');
    assert.match(await page.locator('.combat-range-legend').textContent(), /主角/);
    await page.getByText('可在攻击前后重复移动，直到点数耗尽', { exact: true }).waitFor();
    const blankPoint = await page.locator('#combatMap').evaluate(canvas => canvas._battlefieldTransform.toCanvas({ x: 0, y: 10 }));
    await page.locator('#combatMap').click({ position: blankPoint }); await page.locator('[data-action="combat-map-menu-ability"]').first().waitFor();
    assert.equal(await page.locator('[data-action="combat-map-menu-ability"]').first().isDisabled(), true, '无合法目标的攻击仍可点击');
    assert.match(await page.locator('[data-action="combat-map-menu-ability"]').first().textContent(), /范围内无合法目标/);
    assert.equal(await page.locator('.combat-secondary-actions').count(), 1, '其他行动未收进二级菜单');
    await page.locator('[data-action="combat-map-menu-cancel"]').click();
    assert.equal(await page.locator('.combat-map-menu').count(), 0, '关闭行动菜单后菜单仍残留');
    const clickPoint = await page.locator('#combatMap').evaluate(canvas => canvas._battlefieldTransform.toCanvas({ x: -2, y: 0 }));
    await page.locator('#combatMap').click({ position: clickPoint }); await page.locator('[data-action="combat-map-menu-move"]').waitFor(); await page.locator('.combat-map-wrap').screenshot({ path: path.join(testDir, 'combat-v2-action-menu.png') }); await page.locator('[data-action="combat-map-menu-move"]').click();
    await page.waitForTimeout(400);
    assert.match(await page.locator('.combat-action-notice').textContent(), /移动/);
    await page.locator('[data-action="combat-redo"]').click();
    await page.waitForTimeout(250);
    assert.match(await page.locator('.toast').last().textContent(), /重做上一次玩家行动/);
    const moved = await request(`/api/combat/${battle.id}`);
    const heroPosition = moved.combatants.find(item => item.id === 'hero').position;
    assert.ok(Math.abs(heroPosition.x + 2) < .12 && Math.abs(heroPosition.y) < .12, `地图点击应映射到预期坐标附近，实际为 (${heroPosition.x}, ${heroPosition.y})`);
    await page.locator('[data-combat-flow-step="deploy"]').click();
    await page.locator('#combatRoster').waitFor();
    assert.equal(await page.locator('[data-combat-phase="deploy"]').evaluate(el => el.classList.contains('is-active')), true, '编制部署步骤未显示参战实体');
    assert.match(await page.locator('#combatRoster').textContent(), /主角\s*\(-2\.[01], 0\.[01]\)/);
    await page.locator('[data-combat-flow-step="battle"]').click();
    await page.locator('#combatMap').waitFor();
    const enemyPoint = await page.locator('#combatMap').evaluate(canvas => canvas._battlefieldTransform.toCanvas({ x: 5, y: 0 }));
    await page.locator('#combatMap').click({ position: enemyPoint }); await page.locator('.combat-entity-inspector').waitFor();
    const inspectorText = await page.locator('.combat-entity-inspector').textContent(); assert.match(inspectorText, /HP/); assert.match(inspectorText, /技能清单/); assert.match(inspectorText, /常驻被动/); assert.match(inspectorText, /近战自动反击/); assert.match(inspectorText, /侦察与战术/);
    assert.match(await page.locator('.combat-range-legend').textContent(), /掠夺者/);
    await page.locator('.combat-map-wrap').screenshot({ path: path.join(testDir, 'combat-v2-entity-inspector.png') });
    await page.locator('[data-action="combat-close-entity-inspector"]').click();
    await page.locator('#combatEvents').screenshot({ path: path.join(testDir, 'combat-v2-ledger.png') });
    // Prompt 追踪 lives in the 结果结算 step (read-only paired requests).
    await page.locator('[data-combat-flow-step="result"]').click();
    assert.equal(await page.locator('[data-combat-phase="result"]').evaluate(el => el.classList.contains('is-active')), true, '结果结算阶段未显示');
    assert.equal(await page.locator('[data-action="combat-view-prompt-trace"]').count(), 1, 'Prompt 追踪缺少只读查看入口');
    await page.locator('[data-action="combat-view-prompt-trace"]').click();
    await page.locator('#textEditorDialog[open]').waitFor();
    assert.equal(await page.locator('#textEditorValue').getAttribute('readonly'), '', 'Prompt 追踪编辑器必须是只读');
    assert.match(await page.locator('#textEditorTitle').textContent(), /Prompt 追踪/);
    const promptTrace = await page.evaluate(() => window.__reincarnationApp.getCombatPromptTrace());
    assert.equal(promptTrace.format, 'reincarnation-combat-prompt-trace');
    assert.ok(Array.isArray(promptTrace.storyAi) && Array.isArray(promptTrace.combatAi) && Array.isArray(promptTrace.timeline), 'Prompt 追踪缺少成对记录或时间线');
    await page.locator('[data-editor-action="close"]').last().click();
    await page.locator('[data-combat-flow-step="battle"]').click();
    await page.locator('#combatMap').waitFor();
    // Keep a deterministic, human-reviewable artifact.  A full-page screenshot
    // is unreliable for the app's fixed-height mobile shell; the map element is
    // the actual rendered battlefield and contains the positions under test.
    await page.locator('#combatMap').screenshot({ path: path.join(testDir, 'combat-v2-2d-map.png') });
    await page.locator('#view-combat').screenshot({ path: path.join(testDir, 'combat-v2-2d-console.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, battleId: battle.id, screenshot: path.join(testDir, 'combat-v2-2d-map.png'), pageErrors: errors }, null, 2));
} finally { await browser?.close(); server.kill(); }
