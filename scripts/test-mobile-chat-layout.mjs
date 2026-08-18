import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const storage = {
    settings: { userName: '移动端测试者' }, connections: [], activeSessionId: 'mobile-chat-test',
    sessions: [{
        id: 'mobile-chat-test', title: '移动端沉浸布局', messages: [{ id: 'intro', role: 'assistant', content: '这是一段用于验证移动端沉浸式剧情阅读空间的正文。\n\n屏幕中央应尽可能留给当前剧情楼层。', createdAt: Date.now() }], variableSnapshots: [],
        variables: { stat_data: { 世界: { 名称: '主神空间', 稳定: 100 }, 设置: {}, 系统状态: {}, 关系列表: {}, 主角: { 名称: '移动端测试者', 层级: 'Ⅰ', HP: 17, HP_MAX: 20, EP: 8, EP_MAX: 12, 空间币: 100, 血统: {}, 装备: {}, 道具: {}, 技能: {}, 状态: {}, 最终属性: {} } } },
    }],
};

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('reincarnation-web:v1', JSON.stringify(value)), storage);
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    await page.evaluate(() => {
        const app = window.__reincarnationApp;
        app.store.activeSession.messages[0].content = Array.from({ length: 180 }, (_item, index) => `第 ${index + 1} 段长剧情：正文必须在独立滚动层中继续阅读，而输入框始终固定在屏幕底部。`).join('\n\n');
        app.store.save(); app.renderAll();
    });

    const defaultShell = await page.evaluate(() => {
        const main = document.querySelector('.game-main');
        const rail = document.querySelector('#rail');
        const nav = document.querySelector('.mobile-bottom-nav');
        return {
            mainWidth: main.getBoundingClientRect().width,
            railPosition: getComputedStyle(rail).position,
            railOpen: rail.classList.contains('open'),
            bottomDisplay: getComputedStyle(nav).display,
            navItems: nav.querySelectorAll('[data-panel]').length,
        };
    });
    assert.ok(defaultShell.mainWidth >= 1200, `宽屏没有充分利用纵向单栏的可用空间：${defaultShell.mainWidth}px`);
    assert.equal(defaultShell.railPosition, 'fixed');
    assert.equal(defaultShell.railOpen, false);
    assert.notEqual(defaultShell.bottomDisplay, 'none');
    assert.equal(defaultShell.navItems, 4);

    mkdirSync(path.resolve('.test'), { recursive: true });
    await page.locator('.mobile-bottom-nav [data-panel="chat"]').click();
    await page.screenshot({ path: path.resolve('.test', 'story-viewport-desktop.png'), fullPage: false });

    await page.locator('.mobile-menu').click();
    await page.locator('#rail.open .nav-item[data-panel="status"]').click();
    await page.locator('#view-status').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.mobile-bottom-nav [data-panel="status"]').evaluate(node => node.classList.contains('active')), true);
    await page.locator('.mobile-bottom-nav [data-action="toggle-rail"]').click();
    await page.waitForFunction(() => document.querySelector('#rail')?.classList.contains('open'));
    await page.locator('.mobile-bottom-nav [data-action="toggle-rail"]').click();
    await page.waitForFunction(() => !document.querySelector('#rail')?.classList.contains('open'));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelector('[data-panel="chat"]')?.click());
    await page.locator('#view-chat').waitFor({ state: 'visible' });

    const compact = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const style = selector => getComputedStyle(document.querySelector(selector));
        const chat = rect('#view-chat'); const messages = rect('#messages'); const header = rect('.game-header'); const toolbar = rect('#view-chat .adventure-toolbar');
        return {
            chatHeight: chat.height, messagesHeight: messages.height, headerHeight: header.height, toolbarHeight: toolbar.height,
            composerHeight: rect('#view-chat .composer-wrap').height,
            quickHidden: document.querySelector('#quickActions').classList.contains('hidden'),
            hpVisible: style('.resource.hp').display !== 'none', epVisible: style('.resource.ep').display !== 'none',
            collapsedToolDisplay: style('[data-action="floor-prev"]').display,
            toolToggleDisplay: style('[data-action="toggle-story-tools"]').display,
            bottomNavOffset: rect('.mobile-bottom-nav').top - window.innerHeight,
            messageScrollHeight: document.querySelector('#messages').scrollHeight,
            textareaBottom: rect('#messageInput').bottom,
            composerBottom: rect('#view-chat .composer-wrap').bottom,
            textareaHit: document.elementFromPoint(rect('#messageInput').left + 12, rect('#messageInput').top + 12)?.id,
        };
    });
    assert.ok(compact.messagesHeight >= compact.chatHeight * .84, `正文区未充分占用中心屏幕：${compact.messagesHeight}/${compact.chatHeight}`);
    assert.ok(compact.headerHeight <= 54 && compact.toolbarHeight <= 46, '顶部常驻区域未压缩到移动端高度');
    assert.ok(compact.composerHeight <= 68, '底部输入区在默认折叠状态下过高');
    assert.ok(compact.quickHidden && compact.hpVisible && compact.epVisible, '快捷动作或关键 HP/EP HUD 状态不正确');
    assert.equal(compact.collapsedToolDisplay, 'none');
    assert.notEqual(compact.toolToggleDisplay, 'none');
    assert.ok(compact.bottomNavOffset >= 0, '剧情页底部导航未默认收起，侵占了输入与正文空间');
    assert.ok(compact.messageScrollHeight > compact.messagesHeight, '长正文没有进入独立滚动层，无法覆盖输入框回归场景');
    assert.ok(compact.textareaBottom <= 844 && compact.composerBottom <= 844, '长正文将输入区域挤出了可视屏幕');
    assert.equal(compact.textareaHit, 'messageInput', '输入框被正文层覆盖，无法获得输入焦点');
    await page.screenshot({ path: path.resolve('.test', 'story-viewport-mobile.png'), fullPage: false });

    await page.locator('[data-action="toggle-story-tools"]').click();
    await page.waitForFunction(() => document.querySelector('#view-chat .adventure-toolbar')?.classList.contains('tools-open'));
    assert.notEqual(await page.locator('[data-action="floor-prev"]').evaluate(node => getComputedStyle(node).display), 'none');
    assert.equal(await page.locator('[data-action="toggle-story-tools"]').getAttribute('aria-expanded'), 'true');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('mobile chat layout tests passed');
} finally {
    await browser.close();
}
