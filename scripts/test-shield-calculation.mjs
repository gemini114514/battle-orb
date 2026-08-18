import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const openingResponse = await fetch('http://127.0.0.1:4174/api/opening-data');
assert.ok(openingResponse.ok, `无法读取原卡开局数据库：${openingResponse.status}`);
const opening = await openingResponse.json();
const policeShield = opening.equipments.find(item => item.id === 'e5_2');
assert.deepEqual(policeShield?.attrs, { DEF: 'F' }, '原卡 e5_2 必须是 DEF:F，不能被测试数据替代');
const storage = {
    settings: { userName: '盾牌校验者' }, connections: [], activeSessionId: 'shield-calculation-test',
    sessions: [{
        id: 'shield-calculation-test', title: '警用防爆盾算式校验', messages: [{ id: 'initial', role: 'assistant', content: '盾牌算式校验。', createdAt: Date.now() }], variableSnapshots: [],
        variables: { stat_data: {
            世界: { 名称: '主神空间', 位格: 'Ⅸ', 稳定: 100 }, 设置: {}, 系统状态: {}, 关系列表: {},
            主角: {
                名称: '盾牌校验者', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 0, EP_MAX: 0, 空间币: 1000, 状态: {}, 技能: {}, 道具: {},
                血统: { 人类血统: { 品质: 'F', 标签: ['初始血统', '人类'], 原始属性: { 力量: 'F', 敏捷: 'F', 体质: 'F', 精神: 'F', 魅力: 'F' }, 效果: {} } },
                装备: {
                    [policeShield.name]: { 品质: policeShield.tier, 类型: 0, 标签: [...policeShield.tags, policeShield.source], 原始属性: policeShield.attrs, 效果: policeShield.effects, 描述: policeShield.desc, 消耗: policeShield.consume, 状态: 1 },
                },
                最终属性: {},
            },
        } },
    }],
};

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('reincarnation-web:v1', JSON.stringify(value)), storage);
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime && window.__辅助计算脚本_loaded__ === true);
    await page.evaluate(async () => {
        const app = window.__reincarnationApp;
        await app.runtime.replaceVariables(structuredClone(app.runtime.variables));
    });
    await page.waitForFunction(() => {
        const player = window.__reincarnationApp.runtime.variables.stat_data.主角;
        return Number.isFinite(player.装备?.警用防爆盾?.真属性?.DEF) && player.最终属性?.武器?.无武装;
    });

    const result = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const player = app.runtime.variables.stat_data.主角;
        return {
            loadedCalculator: app.runtime.loadedScripts.find(item => item.name === '辅助计算脚本')?.mode,
            shield: player.装备.警用防爆盾,
            final: player.最终属性,
        };
    });
    assert.match(result.loadedCalculator || '', /DEF 盾牌分类修复/);
    assert.equal(result.shield.类型, 0, '盾牌必须保留原卡的手持类型协议');
    assert.equal(result.shield.原始属性.DEF, 'F', '原卡 DEF:F 不能被改写');
    assert.ok(result.shield.真属性.DEF >= 1 && result.shield.真属性.DEF <= 9, 'F级 DEF 必须按原卡装备 DEF 区间结算');
    assert.equal(result.final.武器.警用防爆盾, undefined, 'DEF-only 盾牌不能被登记为 ATK/MATK 武器');
    assert.ok(result.final.DEF >= result.shield.真属性.DEF, '盾牌 DEF 必须进入最终 DEF 结算');

    await page.locator('[data-panel="inventory"]').first().click();
    await page.locator('.arsenal-terminal').waitFor({ state: 'visible' });
    await page.locator('[data-inventory-tab="tactical"]').click();
    const shieldCard = page.locator('.arsenal-card').filter({ hasText: '警用防爆盾' });
    assert.equal(await shieldCard.locator('small').first().textContent(), '盾牌');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('shield calculation tests passed');
} finally {
    await browser.close();
}
