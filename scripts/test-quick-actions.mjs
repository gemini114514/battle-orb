import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const output = path.resolve('.test');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });

try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#runtimeBadge')?.classList.contains('ready'));
    await page.evaluate(() => {
        const { runtime, store, renderAll } = window.__reincarnationApp;
        const stat = runtime.variables.stat_data;
        stat['世界'] = { 名称: '灰烬废墟', 地点: '断桥哨站', 稳定: 67 };
        stat['系统状态'] = { ...(stat['系统状态'] || {}), 是否在主神空间: false, 是否可试炼: false };
        stat['设置'] = { ...(stat['设置'] || {}), 单一世界: false };
        stat['任务'] = { 列表: {
            '断桥清剿': { 状态: '可结算', 目标: '清理伏击者' },
            '补给线': { 状态: '进行中', 目标: '找到运输队' },
        } };
        store.activeSession.variables = runtime.variables;
        store.save(); renderAll();
    });
    await page.locator('.mobile-bottom-nav [data-panel="chat"]').click();
    assert.equal(await page.locator('.dice-button').count(), 0, '底部不应再保留 D100 按钮');
    const toggle = page.locator('.quick-command-toggle');
    await toggle.click();
    await page.locator('#quickActions:not(.hidden)').waitFor();
    assert.equal(await page.locator('.quick-action-card[data-prompt="【选择世界】"]').count(), 1);
    assert.equal(await page.locator('.quick-action-card[data-prompt="【结算任务】"]').count(), 1);
    assert.equal(await page.locator('.quick-action-card[data-prompt="【申请晋升】"]').count(), 1);
    assert.equal(await page.locator('.quick-action-card[data-prompt="【选择世界】"]').evaluate(node => node.classList.contains('risk')), true);
    assert.equal(await page.locator('.quick-action-card[data-prompt="【结算任务】"]').evaluate(node => node.classList.contains('ready')), true);
    const countBefore = await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.length);
    await page.locator('.quick-action-card[data-prompt="【结算任务】"]').click();
    assert.equal(await page.locator('#messageInput').inputValue(), '【结算任务】');
    assert.equal(await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.length), countBefore, '快捷命令不应自动发送');
    await page.screenshot({ path: path.join(output, 'quick-actions-mvu-state.png'), fullPage: false });

    await page.locator('.mobile-menu').click();
    await page.locator('#rail.open [data-panel="shop"]').click();
    const shopRefresh = page.locator('.ai-refresh-button[data-action="refresh-personal-shop"]');
    await shopRefresh.waitFor();
    assert.equal(await shopRefresh.evaluate(node => node.classList.contains('state-world')), true);
    assert.equal(await shopRefresh.isDisabled(), false, '任务世界的商城刷新仍必须允许玩家自由点击');
    assert.match(await page.locator('.shop-context').innerText(), /任务世界中/);
    await page.screenshot({ path: path.join(output, 'shop-refresh-world-state.png'), fullPage: false });

    await page.evaluate(() => {
        const { runtime, store, renderAll } = window.__reincarnationApp;
        runtime.variables.stat_data['系统状态']['是否在主神空间'] = true;
        store.activeSession.variables = runtime.variables;
        store.save(); renderAll();
    });
    assert.equal(await shopRefresh.evaluate(node => node.classList.contains('state-world')), false);
    assert.match(await page.locator('.shop-context').innerText(), /主神空间终端/);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('quick action and MVU shop-state tests passed');
} finally {
    await browser.close();
}
