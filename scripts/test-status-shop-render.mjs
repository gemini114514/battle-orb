import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const storage = {
    settings: { userName: '渲染测试者' }, connections: [], activeSessionId: 'status-shop-test',
    sessions: [{
        id: 'status-shop-test', title: '显示测试', messages: [{ id: 'initial', role: 'assistant', content: '显示测试。', createdAt: Date.now() }], variableSnapshots: [],
        variables: { stat_data: { 世界: { 名称: '主神空间' }, 设置: {}, 系统状态: {}, 关系列表: {}, 主角: {
            名称: '渲染测试者', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 10, EP_MAX: 10, 空间币: 1000, 血统: {}, 装备: {}, 道具: {}, 技能: {}, 状态: {},
            最终属性: {
                力量: 8, 敏捷: 1, 体质: 14, 精神: 4, 魅力: 0,
                力量修正: 2, 敏捷修正: 0, 体质修正: 3, 精神修正: 1, 魅力修正: 0,
                DEF: 11, MDEF: 4, AP: 15, 物理减伤率: 12, 魔法减伤率: 5, 先攻DC: 14, 防御DC: 12,
                武器: { 无武装: { ATK: 3, MATK: 0 }, 试作短剑: { ATK: 12, MATK: 2 } },
            },
        } } },
        personalShop: { selectedIds: [], customItems: [], history: [], catalog: {
            血统列表: [], 形态列表: [], 技能列表: [], 道具列表: [], 升级列表: [],
            装备列表: [{ id: 'd-test', 名称: 'D级绿色测试剑', 品质: 'D', 类型: 0, 描述: '用于验证商城品质着色。', 原始属性: { ATK: 'D' }, 效果: { 测试: '绿色等级牌' }, 价格: 50 }],
        } },
    }],
};

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('reincarnation-web:v1', JSON.stringify(value)), storage);
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);

    await page.locator('[data-panel="status"]').first().click();
    const panel = page.locator('.final-attribute-panel');
    await panel.waitFor({ state: 'visible' });
    await page.getByText('💪 基础属性', { exact: true }).waitFor();
    assert.equal(await panel.textContent().then(text => text.includes('{"')), false, 'final attributes must not render raw JSON');
    assert.ok((await panel.textContent()).includes('DEF（物防）'));
    assert.ok((await panel.textContent()).includes('ATK（物攻）'));
    const baseD = panel.locator('.final-attribute-grade.q-D').first();
    await baseD.waitFor();
    assert.equal(await baseD.evaluate(node => getComputedStyle(node).color), 'rgb(34, 197, 94)');

    await page.locator('[data-panel="shop"]').first().click();
    const shopD = page.locator('.personal-shop-layout .setup-shop-item.item-card.q-D');
    await shopD.waitFor({ state: 'visible' });
    const shopBadge = shopD.locator('.item-rarity.q-D');
    assert.equal(await shopD.evaluate(node => getComputedStyle(node).borderLeftColor), 'rgb(34, 197, 94)');
    assert.equal(await shopBadge.evaluate(node => getComputedStyle(node).color), 'rgb(34, 197, 94)');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('status and shop renderer tests passed');
} finally {
    await browser.close();
}
