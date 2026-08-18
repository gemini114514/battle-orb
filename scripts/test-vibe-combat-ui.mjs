import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const port = 4191;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
const waitHealth = async () => {
    for (let index = 0; index < 50; index += 1) {
        try { const response = await fetch(`${origin}/api/health`); if (response.ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器未启动');
};

let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const clickMapAbility = async (abilityId, world, battlefield) => {
        const canvas = page.locator('#combatMap');
        await canvas.click({ position: { x: 24, y: 24 } });
        await page.locator(`[data-action="combat-map-menu-ability"][data-combat-ability-id="${abilityId}"]`).click();
        const point = await canvas.evaluate((node, input) => {
            const rect = node.getBoundingClientRect(); const pad = 22;
            const scale = Math.max(.1, Math.min((rect.width - pad * 2) / input.battlefield.widthMeters, (rect.height - pad * 2) / input.battlefield.heightMeters));
            return { x: rect.width / 2 + input.world.x * scale, y: rect.height / 2 - input.world.y * scale };
        }, { world, battlefield });
        await canvas.click({ position: point });
    };
    await page.locator('.nav-item[data-panel="combat"]').dispatchEvent('click');
    await page.locator('[data-action="combat-new"]').click();
    const encounter = { seed: 'ui-fixed', mode: 'manual', encounter: { title: 'UI test', battlefield: { shape: 'rectangle', widthMeters: 40, heightMeters: 20, center: { x: 0, y: 0 } }, zones: [{ id: 'arena', name: '测试竞技场', adjacent: [], capacity: 6 }], combatants: [{ id: 'p', name: '测试主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, attack: 100, attackModifier: 100, defenseDC: 50, initiativeDC: 1000, position: { x: -3, y: 0 }, intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, zoneId: 'arena' }, { id: 'e', name: '测试敌人', side: 'enemy', hp: 10, maxHp: 10, attackModifier: -100, defenseDC: 50, initiativeDC: -100, visionMeters: 1, position: { x: -1, y: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 1, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, zoneId: 'arena' }] } };
    await page.locator('#textEditorValue').fill(JSON.stringify(encounter, null, 2));
    await page.locator('[data-editor-action="save"]').click();
    await page.locator('[data-combat-phase="deploy"].is-active').waitFor();
    await page.locator('[data-action="combat-start"]').click();
    await page.locator('#combatMap').waitFor();
    await page.getByText('测试主角', { exact: true }).last().waitFor();
    const layout = await page.locator('.combat-console-grid').evaluate(node => {
        const style = getComputedStyle(node);
        const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        return {
        display: getComputedStyle(node).display,
        flexDirection: getComputedStyle(node).flexDirection,
        battlefieldWidth: node.querySelector('.battlefield-panel')?.getBoundingClientRect().width,
        contentWidth: node.getBoundingClientRect().width - horizontalPadding,
        sideContainerCount: node.querySelectorAll('.combat-battle-side').length,
        };
    });
    assert.equal(layout.display, 'flex', '战斗阶段必须使用单列布局');
    assert.equal(layout.flexDirection, 'column', '战斗阶段必须纵向排列');
    assert.equal(layout.sideContainerCount, 0, '战斗阶段不应残留右侧并列容器');
    assert.ok(Math.abs(layout.battlefieldWidth - layout.contentWidth) < 3, '二维战场必须占用独占宽度');
    const movePoint = await page.locator('#combatMap').evaluate(canvas => canvas._battlefieldTransform.toCanvas({ x: -2, y: 0 }));
    await page.locator('#combatMap').click({ position: movePoint });
    await page.locator('[data-action="combat-map-menu-move"]').click();
    await page.waitForTimeout(150);
    const hidePoint = await page.locator('#combatMap').evaluate(canvas => canvas._battlefieldTransform.toCanvas({ x: -2, y: 4 }));
    await page.locator('#combatMap').click({ position: hidePoint });
    await page.locator('.combat-secondary-actions>summary').click();
    await page.locator('[data-action="combat-map-menu-maneuver"][data-combat-maneuver="hide"]').click();
    await page.waitForTimeout(250);
    await page.locator('#combatMap').click({ position: { x: 24, y: 24 } });
    await page.locator('.combat-secondary-actions>summary').click();
    await page.locator('[data-action="combat-map-menu-maneuver"][data-combat-maneuver="hide"]').click();
    await page.waitForTimeout(250);
    await clickMapAbility('basic-attack', { x: -1, y: 0 }, encounter.encounter.battlefield);
    await page.getByText('玩家方胜利', { exact: true }).waitFor();
    assert.ok(await page.locator('.combat-round-initiative').count() > 0, '攻击战报必须显示先攻判定段');
    assert.ok(await page.locator('.combat-attack-procedure').count() > 0, '攻击战报必须提供可展开的完整判定流程');
    await page.locator('[data-action="combat-replay"]').click();
    await page.waitForFunction(() => document.querySelector('#textEditorTitle')?.textContent.includes('只读战斗重放'));
    const replay = JSON.parse(await page.locator('#textEditorValue').inputValue());
    assert.equal(replay.format, 'vibe-combat-replay'); assert.ok(replay.events.length > 3); assert.ok(replay.replayHash);
    await page.locator('[data-editor-action="close"]').last().click();

    // First-use script review is visible, tested, explicitly approved, then executable.
    await page.locator('[data-combat-flow-step="initiate"]').click();
    await page.locator('[data-combat-phase="initiate"].is-active').waitFor();
    await page.locator('[data-action="combat-new"]').click();
    const scripted = { seed: 'ui-script', mode: 'manual', encounter: { title: 'Script UI', battlefield: { shape: 'rectangle', widthMeters: 40, heightMeters: 20, center: { x: 0, y: 0 } }, combatants: [{ id: 'p2', name: '脚本主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, attackModifier: 100, initiativeDC: 1000, position: { x: -3, y: 0 }, abilities: [{ id: 'arc', name: '电弧', type: 'true', range: 'contact', script: `api.damage(input.targets[0].id, 200, "true"); // UI review ${Date.now()}` }] }, { id: 'e2', name: '脚本靶', side: 'enemy', hp: 20, maxHp: 20, attackModifier: -100, initiativeDC: -100, position: { x: -1, y: 0 }, visionMeters: 1 }] } };
    await page.locator('#textEditorValue').fill(JSON.stringify(scripted, null, 2)); await page.locator('[data-editor-action="save"]').click();
    await page.locator('[data-action="combat-start"]').click(); await page.getByText('运行 100 组固定种子审查', { exact: true }).waitFor();
    await page.locator('[data-action="combat-inspect-script"]').click();
    await page.waitForFunction(() => document.querySelector('#textEditorValue')?.value.includes('固定种子测试'));
    const reviewText = await page.locator('#textEditorValue').inputValue(); assert.ok(reviewText.includes('100 / 100 通过'));
    await page.locator('[data-editor-action="close"]').last().click(); await page.locator('[data-action="combat-approve-script"]').click();
    await page.locator('[data-action="combat-start"]').click(); await clickMapAbility('arc', { x: -1, y: 0 }, scripted.encounter.battlefield);
    await page.getByText('玩家方胜利', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, battleId: replay.battleId, events: replay.events.length, replayHash: replay.replayHash, pageErrors: errors }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
