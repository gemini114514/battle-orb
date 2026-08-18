import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, '.test');
fs.mkdirSync(testDir, { recursive: true });
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
    for (let index = 0; index < 100; index += 1) {
        try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器未启动');
};
const request = async (pathName, options = {}) => {
    const response = await fetch(`${origin}${pathName}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || response.statusText);
    return body;
};

const unit = (id, name, side, position, extra = {}) => ({
    id, declarationId: id, name, side, controller: side === 'player' ? 'player' : 'ai',
    hp: side === 'player' ? 100 : 12, maxHp: side === 'player' ? 100 : 12,
    ep: 0, maxEp: 0, attack: side === 'player' ? 50 : 1, magicAttack: 0,
    attackModifier: side === 'player' ? 100 : -100, defenseDC: 50, initiativeDC: side === 'player' ? 1000 : -100,
    armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position, facingDegrees: side === 'player' ? 0 : 180,
    fovDegrees: 360, visionMeters: 30,
    attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 },
    intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 30, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 30, attackNoiseMeters: 30 },
    tacticalProfile: { archetype: 'scattered', groupId: id, objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 0 },
    abilities: [{ id: 'basic-attack', name: side === 'player' ? '战矛突刺' : '撕咬', type: 'physical', actionType: 'main', power: side === 'player' ? 50 : 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 2, cooldownRounds: 0, targetCount: 1, aoe: false }],
    ...extra,
});

const encounter = {
    title: '三敌终结后二维战场交互回归测试', location: '测试场',
    battlefield: { shape: 'rectangle', name: '测试场', widthMeters: 30, heightMeters: 20, center: { x: 0, y: 0 } },
    contactEstablished: true, contactPairs: [['hero', 'enemy-1'], ['hero', 'enemy-2'], ['hero', 'enemy-3']],
    combatants: [unit('hero', '测试主角', 'player', { x: -4, y: 0 }), unit('enemy-1', '敌人一', 'enemy', { x: -2.5, y: 0 }), unit('enemy-2', '敌人二', 'enemy', { x: -2.5, y: 2 }), unit('enemy-3', '敌人三', 'enemy', { x: -2.5, y: -2 })],
};

let browser;
try {
    await waitHealth();
    const battle = await request('/api/combat/sessions', { method: 'POST', body: JSON.stringify({ seed: 'completed-map-ui', mode: 'manual', encounter }) });
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    await page.evaluate(id => {
        const session = window.__reincarnationApp.store.activeSession;
        session.activeBattleId = id;
        session.combatIds = [id];
        window.__reincarnationApp.store.save();
    }, battle.id);
    await page.locator('.mobile-bottom-nav [data-panel="combat"]').click();
    // A fresh battle (draft) lands on the guided 编制部署 step; the 2D field is
    // only shown once the battle enters the 战场演算 step.
    await page.locator('[data-combat-phase="deploy"].is-active').waitFor();
    await page.locator('[data-action="combat-start"]').click();
    await page.locator('#combatMap').waitFor();
    await page.waitForFunction(() => window.__reincarnationApp.getCombatState()?.status !== 'draft', null, { timeout: 5000 });
    await page.waitForTimeout(250);

    for (let turn = 0; turn < 8; turn += 1) {
        const state = await page.evaluate(() => window.__reincarnationApp.getCombatState());
        if (state?.status === 'completed') break;
        assert.equal(state?.status, 'paused', `第 ${turn + 1} 次玩家暂停前状态异常：${state?.status}`);
        const actor = state.combatants.find(unitValue => unitValue.id === state.activeUnitId);
        assert.ok(actor, '暂停状态必须有 activeUnitId');
        const legal = (state.pauseReason?.legalActions || []).find(action => action.actionAvailable && action.legalTargetIds?.length);
        if (!legal) {
            await page.locator('#combatMap').click({ position: { x: 20, y: 20 } });
            await page.locator('[data-action="combat-map-menu-wait"]').click();
            await page.waitForFunction(previousVersion => window.__reincarnationApp.getCombatState()?.version > previousVersion || window.__reincarnationApp.getCombatState()?.status === 'completed', state.version, { timeout: 5000 });
            continue;
        }
        const target = state.combatants.find(unitValue => unitValue.id === legal.legalTargetIds[0]);
        const point = await page.locator('#combatMap').evaluate((canvas, position) => canvas._battlefieldTransform.toCanvas(position), target.position);
        await page.locator('#combatMap').click({ position: { x: 20, y: 20 } });
        await page.locator(`[data-action="combat-map-menu-ability"][data-combat-ability-id="${legal.id}"]`).click();
        await page.locator('#combatMap').click({ position: point });
        await page.waitForFunction(() => {
            const stateValue = window.__reincarnationApp.getCombatState();
            return stateValue?.status === 'completed' || stateValue?.status === 'paused' && !window.__reincarnationApp.getCombatState()?.pauseReason?.legalActions?.some(action => action.actionAvailable && action.legalTargetIds?.length);
        }, null, { timeout: 5000 }).catch(() => {});
    }

    await page.waitForFunction(() => window.__reincarnationApp.getCombatState()?.status === 'completed', null, { timeout: 5000 });
    // Completion snaps the flow to 结果结算; return to 战场演算 to keep the
    // finished 2D board interactive for the forensic click test below.
    await page.locator('[data-combat-flow-step="battle"]').click();
    await page.locator('#combatMap').waitFor();
    const completed = await page.evaluate(() => window.__reincarnationApp.getCombatState());
    assert.equal(completed.activeUnitId, null, '完成状态应无 activeUnitId');
    const target = completed.combatants.find(unitValue => unitValue.side === 'enemy');
    const point = await page.locator('#combatMap').evaluate((canvas, position) => canvas._battlefieldTransform.toCanvas(position), target.position);
    await page.locator('#combatMap').click({ position: point });
    await page.locator('.combat-entity-inspector').waitFor({ timeout: 3000 });
    assert.match(await page.locator('.combat-entity-inspector').textContent(), /敌人/);
    assert.ok(await page.evaluate(() => window.__reincarnationApp.getCombatDebugTrace().some(item => item.kind === 'map_entity_selected_inactive_battle')), '完成态地图点击应记录实体检查事件');
    await page.locator('#view-combat').screenshot({ path: path.join(testDir, 'combat-completed-map-inspector.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, battleId: battle.id, status: completed.status, sequence: completed.sequence, pageErrors: errors, screenshot: path.join(testDir, 'combat-completed-map-inspector.png') }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
