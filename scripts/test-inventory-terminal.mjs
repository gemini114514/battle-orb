import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const storage = {
    settings: { userName: '库存测试者' }, connections: [], activeSessionId: 'inventory-test',
    sessions: [{
        id: 'inventory-test', title: '库存测试', messages: [{ id: 'initial', role: 'assistant', content: '库存测试。', createdAt: Date.now() }], variableSnapshots: [],
        variables: { stat_data: { 世界: { 名称: '主神空间' }, 设置: {}, 系统状态: {}, 关系列表: {}, 主角: {
            名称: '库存测试者', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 10, EP_MAX: 10, 空间币: 0, 血统: {}, 技能: {}, 状态: {},
            装备: {
                双持短刃: { 品质: 'D', 类型: 0, 状态: 1, 描述: '第一把已装备武器。' },
                副手匕首: { 品质: 'F', 类型: 0, 状态: 1, 描述: '第二把已装备武器。' },
                第三把短剑: { 品质: 'D', 类型: 0, 状态: 0, 描述: '用于验证双武器槽限制。' },
                已装备头盔: { 品质: 'C', 类型: 2, 状态: 1, 描述: '用于验证单槽替换。' },
                备用头盔: { 品质: 'D', 类型: 2, 状态: 0, 描述: '穿戴时应自动脱下旧头盔。' },
                世界遗物测试件: { 品质: 'S', 类型: 8, 状态: 0, 描述: '不进入常规装备栏。' },
            },
            道具: {
                战术道具一: { 品质: 'F', 状态: 1 }, 战术道具二: { 品质: 'F', 状态: 1 }, 战术道具三: { 品质: 'F', 状态: 1 },
                战术道具四: { 品质: 'F', 状态: 1 }, 战术道具五: { 品质: 'F', 状态: 1 }, 备用道具: { 品质: 'D', 状态: 0 },
            },
        } } },
    }],
};

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('reincarnation-web:v1', JSON.stringify(value)), storage);
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    await page.locator('[data-panel="inventory"]').first().click();
    await page.locator('.arsenal-terminal').waitFor({ state: 'visible' });

    const dBadge = page.locator('.arsenal-card.q-D .arsenal-quality.q-D').first();
    await dBadge.waitFor();
    assert.equal(await dBadge.evaluate(node => getComputedStyle(node).color), 'rgb(34, 197, 94)');
    assert.equal(await page.locator('.arsenal-card.q-D').first().evaluate(node => getComputedStyle(node).borderLeftColor), 'rgb(34, 197, 94)');
    assert.equal(await page.locator('.arsenal-slot[title^="武器"]').textContent(), '武器2 / 2');
    assert.ok(await page.locator('.arsenal-slot[title^="武器"]').evaluate(node => node.classList.contains('is-full')));

    await page.locator('[data-inventory-tab="equipment"]').click();
    await page.locator('[data-inventory-action="wear"][data-inventory-name="第三把短剑"]').click();
    await page.getByText('身上武器已满(2件)', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__reincarnationApp.runtime.variables.stat_data.主角.装备.第三把短剑.状态), 0);

    assert.equal(await page.locator('[data-inventory-action][data-inventory-name="世界遗物测试件"]').count(), 0);
    await page.locator('[data-inventory-action="wear"][data-inventory-name="备用头盔"]').click();
    await page.waitForFunction(() => window.__reincarnationApp.runtime.variables.stat_data.主角.装备.备用头盔.状态 === 1);
    const headgear = await page.evaluate(() => {
        const equipment = window.__reincarnationApp.runtime.variables.stat_data.主角.装备;
        return [equipment.已装备头盔.状态, equipment.备用头盔.状态];
    });
    assert.deepEqual(headgear, [0, 1]);

    await page.locator('[data-inventory-tab="item"]').click();
    await page.locator('[data-inventory-action="wear"][data-inventory-name="备用道具"]').click();
    await page.getByText('身上负重已满(5个道具)', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__reincarnationApp.runtime.variables.stat_data.主角.道具.备用道具.状态), 0);

    await page.locator('[data-inventory-tab="equipment"]').click();
    await page.locator('[data-inventory-action="store"][data-inventory-name="第三把短剑"]').click();
    await page.waitForFunction(() => window.__reincarnationApp.runtime.variables.stat_data.主角.装备.第三把短剑.状态 === 2);
    await page.locator('[data-inventory-tab="storage"]').click();
    await page.locator('.arsenal-card').getByText('第三把短剑', { exact: true }).waitFor();
    await page.locator('[data-inventory-action="takeback"][data-inventory-name="第三把短剑"]').click();
    await page.waitForFunction(() => window.__reincarnationApp.runtime.variables.stat_data.主角.装备.第三把短剑.状态 === 0);

    const blackbox = await page.evaluate(async () => (await window.__reincarnationApp.blackbox.events()).filter(item => item.category === 'inventory').map(item => item.type));
    assert.ok(blackbox.includes('item_status_changed'));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('inventory terminal tests passed');
} finally {
    await browser.close();
}
