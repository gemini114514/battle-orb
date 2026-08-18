import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url);
const appRoot = fileURLToPath(root);
const screenshotDir = path.join(appRoot, '.test');
fs.mkdirSync(screenshotDir, { recursive: true });
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
const server = spawn(process.execPath, ['server.js'], { cwd: appRoot, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });

const waitHealth = async () => {
    for (let index = 0; index < 60; index += 1) {
        try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
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
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const before = await page.evaluate(() => {
        const session = window.__reincarnationApp.store.activeSession;
        session.activeBattleId = null;
        session.combatIds = [];
        window.__reincarnationApp.store.save();
        return { activeBattleId: session.activeBattleId, combatIds: [...session.combatIds] };
    });
    assert.equal(before.activeBattleId, null);
    await page.locator('.mobile-bottom-nav [data-panel="combat"]').click();
    await page.locator('#combatSimulatorFold>summary').click();
    assert.equal(await page.locator('[data-action="combat-simulator-scenario"]').count(), 5, 'five standard simulator scenarios are required');
    await page.locator('[data-simulator-scenario="same-tier-horde"]').click();
    await page.waitForFunction(() => document.querySelector('#combatSimulatorState')?.textContent.includes('本能丧尸群'));
    await page.locator('#combatMap').waitFor();
    await page.waitForFunction(() => /^模拟 · (已暂停|已完成)$/.test(document.querySelector('#combatStatus')?.textContent || ''), null, { timeout: 15000 });
    assert.match(await page.locator('#combatStatus').textContent(), /^模拟 · (已暂停|已完成)/, 'loading must also start the simulator');
    const mapPixels = await page.locator('#combatMap').evaluate(canvas => ({ width: canvas.width, height: canvas.height, data: canvas.getContext('2d').getImageData(0, 0, 1, 1).data.length }));
    assert.ok(mapPixels.width > 100 && mapPixels.height > 100 && mapPixels.data === 4, 'a rendered 2D battle canvas is required after load');
    const baselineEnemy = await page.evaluate(() => {
        const state = window.__reincarnationApp.getCombatState();
        return state?.combatants?.find(unit => unit.side === 'enemy') || null;
    });
    assert.ok(baselineEnemy, 'same-tier simulator must create an enemy unit');
    assert.equal(baselineEnemy.attack, 9, '生命层级 I 丧尸必须使用原卡基准 ATK 9');
    assert.equal(baselineEnemy.magicAttack, 2, '生命层级 I 丧尸必须使用原卡基准 MATK 2');
    assert.equal(baselineEnemy.attackModifier, 5, '生命层级 I 丧尸不能继承玩家的攻击修正');
    const afterLoad = await page.evaluate(() => {
        const session = window.__reincarnationApp.store.activeSession;
        return { activeBattleId: session.activeBattleId || null, combatIds: [...(session.combatIds || [])] };
    });
    assert.deepEqual(afterLoad, before, 'simulator load must not write a formal battle to the story save');
    await page.locator('#combatMap').screenshot({ path: path.join(screenshotDir, 'combat-simulator-cases.png') });
    await page.locator('#view-combat').screenshot({ path: path.join(screenshotDir, 'combat-simulator-loaded.png') });
    await page.locator('#combatMode').selectOption('auto');
    await page.waitForTimeout(150);
    await page.locator('[data-action="combat-advance"]').click();
    await page.waitForFunction(() => document.querySelector('#combatStatus')?.textContent.includes('已完成'), null, { timeout: 15000 });
    await page.locator('[data-combat-flow-step="deploy"]').click();
    await page.locator('#combatRoster').waitFor();
    await page.locator('[data-action="combat-toggle-cohorts"]').click();
    assert.match(await page.locator('#combatRoster').textContent(), /本能丧尸/);
    await page.locator('[data-combat-flow-step="result"]').click();
    await page.locator('#combatResult').waitFor();
    assert.equal(await page.locator('#combatNarrateButton').textContent(), '将模拟测试写回正文 AI');
    assert.equal(await page.locator('#combatNarrateButton').isDisabled(), false);
    await page.locator('#combatResult').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, 'combat-simulator-mode.png'), fullPage: true });
    // All advertised scenario cards must build the same V2 map and enter an
    // actual local turn state, not merely replace the simulator label.
    for (const [scenarioId, marker] of [['two-tier-boss', '高二生命层级 BOSS'], ['boss-with-minions', 'BOSS ＋ 同级随从'], ['goblin-squad', '哥布林小队'], ['hive-machines', '格式塔机械体']]) {
        await page.locator('[data-combat-flow-step="initiate"]').click();
        await page.locator('#combatSimulatorFold').evaluate(el => { el.open = true; });
        await page.locator('#combatMode').selectOption('manual');
        await page.evaluate(() => document.querySelector('[data-action="combat-toggle-simulator-picker"]').click());
        await page.waitForTimeout(250);
        await page.evaluate(id => document.querySelector(`[data-simulator-scenario="${id}"]`).click(), scenarioId);
        await page.waitForFunction(expected => document.querySelector('#combatSimulatorState')?.textContent.includes(expected), marker);
        await page.waitForFunction(() => /^模拟 · (已暂停|已完成)$/.test(document.querySelector('#combatStatus')?.textContent || ''), null, { timeout: 15000 });
        assert.equal(await page.locator('#combatMode').inputValue(), 'manual');
        assert.match(await page.locator('#combatStatus').textContent(), /模拟 · 已暂停/, `${scenarioId} 手操启动必须停在可操作界面，而不是直接终局`);
        assert.notEqual((await page.locator('#combatActiveUnit').textContent()).trim(), '—', `${scenarioId} 手操启动必须显示当前行动单位`);
        const rendered = await page.locator('#combatMap').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
        assert.ok(rendered.width > 100 && rendered.height > 100, `${scenarioId} must render a V2 map`);
    }
    await page.locator('[data-combat-flow-step="initiate"]').click();
    await page.locator('#combatSimulatorFold').evaluate(el => { el.open = true; });
    await page.locator('[data-action="combat-exit-simulator"]').click();
    await page.waitForFunction(() => document.querySelector('#combatSimulatorState')?.textContent.trim() === '未启用');
    const afterExit = await page.evaluate(() => {
        const session = window.__reincarnationApp.store.activeSession;
        return { activeBattleId: session.activeBattleId || null, combatIds: [...(session.combatIds || [])] };
    });
    assert.deepEqual(afterExit, before, 'exiting simulator must preserve the formal battle list');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, scenarios: 5, screenshots: [path.join(screenshotDir, 'combat-simulator-cases.png'), path.join(screenshotDir, 'combat-simulator-loaded.png'), path.join(screenshotDir, 'combat-simulator-mode.png')], pageErrors: errors }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
