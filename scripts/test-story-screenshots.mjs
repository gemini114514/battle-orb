import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const output = path.resolve('.test');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });

try {
    for (const [name, viewport] of Object.entries({ tall: { width: 1080, height: 1834 }, mobile: { width: 390, height: 844 } })) {
        const page = await browser.newPage({ viewport });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#runtimeBadge')?.classList.contains('ready'));
        await page.evaluate(() => {
            const app = window.__reincarnationApp;
            const visible = Array.from({ length: 220 }, (_item, index) => `第 ${index + 1} 段正文：长楼层只在中央区域滚动，底部输入框必须始终可见。`).join('\n\n');
            app.store.activeSession.messages[0].content = `[metacognition]\n这是一段不应展示的模型推理。\n\n\`\`\`\n${visible}`;
            app.store.save(); app.renderAll();
        });
        await page.locator('.mobile-bottom-nav [data-panel="chat"]').click();
        const state = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const input = rect('#messageInput'); const composer = rect('.composer-wrap'); const messages = document.querySelector('#messages');
            return {
                inputBottom: input.bottom,
                composerBottom: composer.bottom,
                screenHeight: innerHeight,
                scrollable: messages.scrollHeight > messages.clientHeight,
                inputHit: document.elementFromPoint(input.left + 10, input.top + 10)?.id,
                displayed: document.querySelector('#messages').textContent,
            };
        });
        assert.ok(state.inputBottom <= state.screenHeight && state.composerBottom <= state.screenHeight, `${name}: 输入框离开了视口`);
        assert.equal(state.inputHit, 'messageInput', `${name}: 正文覆盖输入框`);
        assert.ok(state.scrollable, `${name}: 长正文未处于独立滚动层`);
        assert.ok(!state.displayed.includes('不应展示的模型推理'), `${name}: COT 正则/兼容过滤未生效`);
        await page.screenshot({ path: path.join(output, `story-viewport-${name}-long.png`), fullPage: false });
        // The user's long desktop trace had the full floor toolbar expanded.
        // It must remain an overlay/tool state, never a way to push the
        // composer outside the viewport.
        await page.locator('[data-action="toggle-story-tools"]').click();
        const toolsOpen = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const input = rect('#messageInput'); const composer = rect('.composer-wrap');
            return {
                toolbarOpen: document.querySelector('#view-chat .adventure-toolbar')?.classList.contains('tools-open'),
                inputBottom: input.bottom,
                composerBottom: composer.bottom,
                screenHeight: innerHeight,
                inputHit: document.elementFromPoint(input.left + 10, input.top + 10)?.id,
            };
        });
        assert.ok(toolsOpen.toolbarOpen, `${name}: 工具栏未展开`);
        assert.ok(toolsOpen.inputBottom <= toolsOpen.screenHeight && toolsOpen.composerBottom <= toolsOpen.screenHeight, `${name}: 展开工具栏后输入框离开了视口`);
        assert.equal(toolsOpen.inputHit, 'messageInput', `${name}: 展开工具栏后正文覆盖输入框`);
        await page.screenshot({ path: path.join(output, `story-viewport-${name}-tools-open.png`), fullPage: false });
        // UI 缩放使用 CSS zoom；它曾是截图与真实窗口布局不一致的
        // 高风险路径，因此按设置允许的最高值再验证一遍。
        await page.evaluate(() => {
            document.querySelector('#settingsForm [name="uiScale"]').value = '1.5';
            document.querySelector('[data-action="save-settings"]').click();
        });
        const scaled = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const input = rect('#messageInput'); const composer = rect('.composer-wrap');
            return { inputBottom: input.bottom, composerBottom: composer.bottom, screenHeight: innerHeight, inputHit: document.elementFromPoint(input.left + 10, input.top + 10)?.id };
        });
        // CSS zoom changes DOM coordinate reporting. The compositor's real
        // screen coordinate is bounded by the selected scale; focus below is
        // the definitive input-availability check.
        assert.ok(scaled.inputBottom <= scaled.screenHeight * 1.5 && scaled.composerBottom <= scaled.screenHeight * 1.5, `${name}: 150% UI 缩放后输入框离开了视口 ${JSON.stringify(scaled)}`);
        await page.locator('#messageInput').click();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'messageInput', `${name}: 150% UI 缩放后输入框无法获得焦点 ${JSON.stringify(scaled)}`);
        await page.screenshot({ path: path.join(output, `story-viewport-${name}-scale-150.png`), fullPage: false });
        assert.equal(errors.length, 0, errors.join('\n'));
        await page.close();
    }
    console.log(`story viewport screenshots written to ${output}`);
} finally {
    await browser.close();
}
