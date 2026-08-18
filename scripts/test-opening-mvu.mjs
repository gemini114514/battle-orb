import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('reincarnation-web:v1', JSON.stringify({
        settings: { userName: '迁移前' }, connections: [], activeSessionId: 'legacy', sessions: [{ id: 'legacy', title: '旧档', messages: [], variables: { stat_data: { 世界: { 名称: '主神空间' }, 主角: { 血统: {}, 装备: {}, 道具: {}, 技能: {}, 身份: [], 种族: '' }, 设置: {}, 系统状态: {}, 关系列表: { 旧NPC: { 好感度: 7 } } }, 世界: { 名称: '旧根层世界' }, 主角: { 空间币: 321 } }, variableSnapshots: [] }]
    })));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime && document.querySelectorAll('[data-starter-id]').length > 50);
    const migration = await page.evaluate(() => { const v = window.__reincarnationApp.store.activeSession.variables; return { rootWorld: v.世界, world: v.stat_data.世界.名称, coins: v.stat_data.主角.空间币, legacyAffection: v.stat_data.关系列表.旧NPC.好感度关系.主角, playerRelations: v.stat_data.主角.好感度关系 }; });
    await page.evaluate(() => window.__reincarnationApp.newSession());
    await page.locator('[data-panel="chat"]').first().click();
    await page.locator('[data-cover-agree]').check(); await page.locator('[data-action="enter-game"]').click();
    await page.getByRole('button', { name: '开始建档', exact: true }).click();
    await page.locator('#setupForm [name="name"]').fill('完整开局测试');
    await page.locator('[data-attribute="敏捷"][data-delta="1"]').click();
    await page.locator('[data-action="setup-next"]').click();
    const chosenName = await page.locator('#setupShopItems [data-starter-id]').first().locator('h4').textContent();
    await page.locator('#setupShopItems [data-starter-id]').first().click();
    await page.locator('[data-action="setup-next"]').click();
    await page.locator('#setupForm [name="mode"][value="候选世界"]').check();
    await page.locator('[data-plot-id]').first().click();
    await page.locator('[data-action="setup-next"]').click();
    await page.locator('#setupForm [name="partnerEnabled"]').check();
    await page.locator('#setupForm [name="partnerName"]').fill('测试队友');
    await page.locator('#setupForm [name="partnerTier"]').selectOption('Ⅰ');
    await page.locator('#setupForm [name="partnerBackground"]').fill('用于验证完整队友写入。');
    await page.locator('[data-action="setup-next"]').click();
    await page.locator('#profileName').fill('端到端测试档案');
    await page.locator('[data-action="save-profile"]').click();
    await page.getByText('端到端测试档案', { exact: true }).waitFor();
    await page.locator('#setupForm').evaluate(form => form.requestSubmit());
    await page.locator('#setupDialog').waitFor({ state: 'hidden' });
    const result = await page.evaluate(async chosen => {
        const app = window.__reincarnationApp; const stat = app.runtime.variables.stat_data;
        const patched = await app.runtime.parseVariableUpdate('<UpdateVariable><JSONPatch>[{"op":"replace","path":"/世界/地点","value":"MVU测试地点"},{"op":"delta","path":"/主角/空间币","value":5}]</JSONPatch></UpdateVariable>', app.runtime.variables);
        return {
            migration: null,
            rootKeys: Object.keys(app.runtime.variables),
            bloodline: stat.主角.血统['人类血统']?.原始属性,
            coins: stat.主角.空间币,
            chosenPersisted: Boolean(stat.主角.装备[chosen] || stat.主角.道具[chosen] || stat.主角.技能[chosen]),
            partner: stat.关系列表['测试队友'],
            world: stat.世界.名称,
            promptHasGuard: document.querySelector('#messageInput').value.includes('精准写入 stat_data'),
            patchedLocation: patched.stat_data.世界.地点,
            patchedCoins: patched.stat_data.主角.空间币,
            roguePatchRoots: Boolean(patched.世界 || patched.主角),
            profiles: (await indexedDB.databases()).some(db => db.name === 'reincarnation-library'),
        };
    }, chosenName);
    result.migration = migration;
    console.log(JSON.stringify({ ...result, pageErrors: errors }, null, 2));
    if (migration.rootWorld !== undefined || migration.world !== '旧根层世界' || migration.coins !== 321 || migration.legacyAffection !== 7 || Object.keys(migration.playerRelations).length !== 0 || !result.bloodline || result.bloodline.敏捷 !== 'E' || !result.chosenPersisted || result.partner?.是否队友 !== true || result.patchedLocation !== 'MVU测试地点' || result.patchedCoins !== result.coins + 5 || result.roguePatchRoots || !result.promptHasGuard || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
