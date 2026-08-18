import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    await page.evaluate(() => {
        const app = window.__reincarnationApp;
        document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-chat'));
        app.store.activeSession.messages = [{
            id: 'world-iframe-layout-test', role: 'assistant', createdAt: Date.now(), content: `【选择世界】\n\n<mission>
【《哈利·波特与密室》】
(世界位格: Ⅳ)
[副本难度]: F-E级
[时间锚点]: 霍格沃茨开学季，密室即将开启
[干涉模式]: 本土无其他轮回者存在，保留完整原剧情轨道
[主神任务]: 调查密室开启原因并完成生存目标
[预期收益]: 基础空间币 15000，幽能合金核心与情报奖励

【《兵临城下》】
(世界位格: Ⅱ)
[副本难度]: E-D级
[时间锚点]: 斯大林格勒战役中段，城市战即将升级
[干涉模式]: 战区上空爆发未知维度天灾，敌我双方均受影响
[主神任务]: 在城市战中完成侦察与撤离
[预期收益]: 基础空间币 4000，咒怨结晶与战术情报

【《三国演义》】
(世界位格: Ⅲ)
[副本难度]: F-E级
[时间锚点]: 官渡之战前夕，乌巢粮道即将对峙
[干涉模式]: 本土无异常存在，但局部势力会改变历史节点
[主神任务]: 夺取粮道并安全撤离
[预期收益]: 基础空间币 6000，装备材料与阵营声望
</mission>` }];
        app.store.save();
        app.renderAll();
    });
    await page.waitForTimeout(1800);
    const result = await page.evaluate(() => {
        const frame = document.querySelector('#messages .story-narrative iframe.tavern-html-frame');
        const doc = frame?.contentDocument;
        const scrollables = [...(doc?.querySelectorAll('*') || [])].filter(node => {
            const style = getComputedStyle(node);
            return (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') && node.scrollHeight > node.clientHeight + 2;
        }).map(node => ({ tag: node.tagName, className: node.className || '', scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
        return {
            frameCount: document.querySelectorAll('#messages .story-narrative iframe.tavern-html-frame').length,
            frameHeight: Number.parseFloat(frame?.style.height || '0') || 0,
            frameWidth: frame?.getBoundingClientRect().width || 0,
            bodyBackground: doc ? getComputedStyle(doc.body).backgroundColor : '',
            rootOverflow: doc ? getComputedStyle(doc.documentElement).overflow : '',
            optionCount: doc?.querySelectorAll('.world-option').length || 0,
            internalScrollbars: scrollables,
        };
    });
    result.pageErrors = errors;
    await page.screenshot({ path: 'C:\\SillyTavern\\reincarnation-web\\.test\\world-iframe-layout.png', fullPage: true });
    console.log(JSON.stringify(result, null, 2));
    if (result.frameCount !== 1 || result.optionCount !== 3 || result.frameHeight <= 0 || result.bodyBackground !== 'rgb(17, 21, 15)' || result.rootOverflow !== 'visible' || result.internalScrollbars.length || result.pageErrors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
