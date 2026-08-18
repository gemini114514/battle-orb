import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4190;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
const waitHealth = async () => { for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('测试服务器未启动'); };

let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const declaration = { schema: 'vibe-combat-declaration/v3', worldLifeLevel: 'Ⅱ', participants: [{ id: 'hero', side: 'player', source: 'existing', reference: '主角' }, { id: 'hound', side: 'enemy', source: 'existing', reference: '本地丧尸犬' }] };
    const model = { combatants: [
        { id: 'hero', declarationId: 'hero', side: 'player', attack: 99, magicAttack: 99, armor: 0, resistance: 0, hp: 1, maxHp: 1, attributes: {} },
        { id: 'hound', declarationId: 'hound', side: 'enemy', attack: 999, magicAttack: 999, armor: 0, resistance: 0, hp: 999, maxHp: 999, abilities: [{ id: 'basic-attack', power: 20, modifier: 3 }] },
    ] };
    const result = await page.evaluate(({ declarationValue, modelValue }) => {
        const app = window.__reincarnationApp;
        const relation = { '本地丧尸犬': { 层级: 'Ⅰ', 在场: true, HP: 18, HP_MAX: 18, EP: 0, EP_MAX: 0, 最终属性: { ATK: 7, MATK: 0, 力量修正: 2, 敏捷修正: 3, 防御DC: 28, 物理减伤率: 4, 魔法减伤率: 1 }, 装备: { 牙齿: { 状态: 1, 名称: '牙齿', 战斗资产ID: 'asset-hound-bite' } }, 技能: { 撕咬: { 描述: '本地技能档案' } }, 战斗档案: { attack: 7, magicAttack: 0, attackModifier: 2, defenseDC: 28, armor: 4, resistance: 1, abilities: [{ id: 'basic-attack', name: '本地撕咬', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] } } };
        return (async () => { app.store.activeSession.variables = { stat_data: { 主角: { 姓名: '主角', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 0, EP_MAX: 0, 最终属性: { ATK: 10, MATK: 0 } }, 关系列表: relation, 世界: {}, 设置: {}, 系统状态: {} } }; const assets = await app.ensureCombatAssetContext(); const known = app.battleKnownEntities(); const attached = app.attachAuthoritativeExistingEntities(modelValue, declarationValue); app.renderRelations(); return { assets, known: known.find(item => item.reference === '本地丧尸犬'), unit: attached.combatants.find(item => item.id === 'hound'), cards: document.querySelectorAll('.relation-entity-card').length, text: document.querySelector('#relationContent')?.textContent || '' }; })();
    }, { declarationValue: declaration, modelValue: model });
    assert.equal(result.known.localCombat.attack, 7, 'knownEntities 必须携带本地战斗快照');
    assert.equal(result.unit.attack, 7, 'existing 实体必须覆盖模型临时攻击值');
    assert.equal(result.unit.hp, 18);
    assert.equal(result.unit.combatProvenance.localSnapshotApplied, true);
    assert.equal(result.assets.find(asset => asset.assetId === 'asset-hound-bite')?.name, '牙齿', 'NPC 战斗资产必须进入 requiredAssets');
    assert.match(result.text, /本地丧尸犬/);
    assert.match(result.text, /装备/);
    assert.match(result.text, /技能/);
    assert.match(result.text, /血统/);
    assert.match(result.text, /五维与最终属性/);
    assert.equal(result.cards, 1);
    assert.deepEqual(errors, []);
    await page.evaluate(() => document.querySelector('[data-panel="relations"]')?.click());
    await page.locator('#view-relations.active').waitFor({ state: 'visible' });
    const screenshot = path.join(root, '.test', 'entity-relations-dossier.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    const persistedProfile = await page.evaluate(async () => { const app = window.__reincarnationApp; await app.runtime.replaceVariables(app.runtime.variables); return app.runtime.variables.stat_data['关系列表']['本地丧尸犬']['战斗档案']; });
    assert.equal(persistedProfile.attack, 7, 'MVU 校验/写回不能吞掉实体战斗档案');
    console.log(JSON.stringify({ ok: true, localAttack: result.unit.attack, localHp: result.unit.hp, cards: result.cards, screenshot, pageErrors: errors }, null, 2));
} finally { await browser?.close(); server.kill(); }
