import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' }); await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const result = await page.evaluate(() => {
        const runtime = window.__reincarnationApp.runtime;
        runtime.setRegexPresets([{ enabled: true, scripts: [
            { scriptName: 'prompt', findRegex: '/SECRET/g', replaceString: 'MASKED', placement: [1], promptOnly: true, markdownOnly: false, minDepth: 1 },
            { scriptName: 'display', findRegex: '/RAW/g', replaceString: '**FORMATTED**', placement: [2], promptOnly: false, markdownOnly: true },
            { scriptName: 'both', findRegex: '/X/g', replaceString: 'Y', placement: [1, 2], promptOnly: false, markdownOnly: false },
            { scriptName: 'disabled', findRegex: '/NO/g', replaceString: 'BAD', placement: [1, 2], disabled: true },
        ] }]);
        return {
            promptDepth0: runtime.applyPromptRegex('SECRET X NO', 'user', 0),
            promptDepth1: runtime.applyPromptRegex('SECRET X NO', 'user', 1),
            displayAssistant: runtime.applyExternalDisplayRegex('RAW X NO', 'assistant', 0),
            displayUser: runtime.applyExternalDisplayRegex('RAW X', 'user', 0),
        };
    });
    console.log(JSON.stringify({ ...result, pageErrors: errors }, null, 2));
    if (result.promptDepth0 !== 'SECRET Y NO' || result.promptDepth1 !== 'MASKED Y NO' || result.displayAssistant !== '**FORMATTED** Y NO' || result.displayUser !== 'RAW Y' || errors.length) process.exitCode = 1;

    const cardDisplay = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        app.runtime.setRegexPresets([]);
        app.runtime.card.extensions.regex_scripts.push({ scriptName: '卡内显示隐藏测试', findRegex: '/<cot>[\\s\\S]*?<\\/cot>/gi', replaceString: '', placement: [2], markdownOnly: true, promptOnly: false, disabled: false });
        app.store.activeSession.messages = [{ id: 'card-regex-display-test', role: 'assistant', content: '<cot>MODEL SECRET COT</cot>\n可见正文', createdAt: Date.now() }];
        app.renderAll();
        return document.querySelector('#messages .story-narrative')?.textContent || '';
    });
    if (cardDisplay.includes('MODEL SECRET COT') || !cardDisplay.includes('可见正文')) process.exitCode = 1;

    // The latest Tavern trace contains these semantic blocks. Their card regex
    // replacements are complete HTML documents wrapped in Markdown fences;
    // the independent client must mount those documents (including scripts)
    // rather than replacing them with an unrelated local widget.
    await page.evaluate(() => {
        const app = window.__reincarnationApp;
        document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item.id === 'view-chat'));
        app.store.activeSession.messages = [{ id: 'trace-semantic-display-test', role: 'assistant', content: [
            '<CheckResult>\n> [攻击] 艾莉丝 → 丧尸\n> 推演：D100=42 vs DC30\n> 总结：命中，造成 9 点伤害\n</CheckResult>',
            '<options>\n1. 观察环境\n2. 继续前进\n</options>',
            '<mission>\n任务状态：调查主神空间\n</mission>',
            '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/hp","value":47}]</JSONPatch>\n</UpdateVariable>',
        ].join('\n'), createdAt: Date.now() }];
        // Mirror a real persisted chat turn so a refresh action cannot hydrate
        // an older branch/session fixture while the assertion is running.
        app.store.save();
        app.renderAll();
    });
    await page.waitForTimeout(700);
    const semanticDisplay = await page.evaluate(() => {
        const narrative = document.querySelector('#messages .story-narrative');
        const frames = [...(narrative?.querySelectorAll('iframe.tavern-html-frame') || [])];
        return {
            text: narrative?.textContent || '',
            html: narrative?.innerHTML || '',
            iframeCount: frames.length,
            iframeBodies: frames.map(frame => frame.contentDocument?.body?.textContent || ''),
            variableCount: narrative?.querySelectorAll('details').length || 0,
            rawHtmlSource: /<!doctype\\s+html|<html[\\s>]/i.test(narrative?.innerHTML || ''),
        };
    });
    console.log(JSON.stringify({ semanticDisplay }, null, 2));
    if (
        semanticDisplay.iframeCount !== 3 ||
        semanticDisplay.variableCount < 1 ||
        semanticDisplay.rawHtmlSource ||
        !semanticDisplay.iframeBodies.some(text => text.includes('攻击')) ||
        !semanticDisplay.iframeBodies.some(text => text.includes('观察环境')) ||
        !semanticDisplay.iframeBodies.some(text => text.includes('世界'))
    ) process.exitCode = 1;

    // A real card owns the collapse state inside its document. The host must
    // follow that state instead of leaving a micro-scrollbar inside the iframe
    // and must keep the dark page canvas transparent.
    const frameLayoutBefore = await page.evaluate(() => {
        const frame = document.querySelectorAll('#messages .story-narrative iframe.tavern-html-frame')[1];
        const details = frame?.contentDocument?.querySelector('details.card-final-version');
        if (!frame || !details) return { height: 0, hasDetails: false };
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        return { height: Number.parseFloat(frame.style.height) || 0, hasDetails: true };
    });
    await page.waitForTimeout(350);
    const frameLayoutAfter = await page.evaluate(() => {
        const frame = document.querySelectorAll('#messages .story-narrative iframe.tavern-html-frame')[1];
        const doc = frame?.contentDocument;
        return {
            height: Number.parseFloat(frame?.style.height || '0') || 0,
            scrollHeight: doc?.documentElement?.scrollHeight || 0,
            background: doc ? getComputedStyle(doc.body).backgroundColor : '',
            overflow: doc ? getComputedStyle(doc.documentElement).overflow : '',
        };
    });
    semanticDisplay.frameLayout = { before: frameLayoutBefore, after: frameLayoutAfter };
    console.log(JSON.stringify({ frameLayout: semanticDisplay.frameLayout }, null, 2));
    if (
        !frameLayoutBefore.hasDetails ||
        frameLayoutAfter.height < frameLayoutBefore.height ||
        frameLayoutAfter.height + 4 < frameLayoutAfter.scrollHeight ||
        frameLayoutAfter.background !== 'rgb(17, 21, 15)' ||
        frameLayoutAfter.overflow !== 'visible'
    ) process.exitCode = 1;
    const frameLayoutCollapsed = await page.evaluate(() => {
        const frame = document.querySelectorAll('#messages .story-narrative iframe.tavern-html-frame')[1];
        const details = frame?.contentDocument?.querySelector('details.card-final-version');
        if (!frame || !details) return { height: 0, hasDetails: false };
        details.open = false;
        details.dispatchEvent(new Event('toggle'));
        return { height: Number.parseFloat(frame.style.height) || 0, hasDetails: true };
    });
    await page.waitForTimeout(350);
    const frameLayoutCollapsedAfter = await page.evaluate(() => {
        const frame = document.querySelectorAll('#messages .story-narrative iframe.tavern-html-frame')[1];
        const doc = frame?.contentDocument;
        return {
            height: Number.parseFloat(frame?.style.height || '0') || 0,
            scrollHeight: doc?.documentElement?.scrollHeight || 0,
        };
    });
    semanticDisplay.frameLayout.collapsed = { before: frameLayoutCollapsed, after: frameLayoutCollapsedAfter };
    console.log(JSON.stringify({ collapsedLayout: semanticDisplay.frameLayout.collapsed }, null, 2));
    if (!frameLayoutCollapsed.hasDetails || frameLayoutCollapsedAfter.height >= frameLayoutAfter.height || frameLayoutCollapsedAfter.height + 4 < frameLayoutCollapsedAfter.scrollHeight) process.exitCode = 1;

    const manualRefreshDisplay = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const body = document.querySelector('#messages .story-narrative');
        body.textContent = '陈旧 DOM：MODEL SECRET COT';
        document.querySelector('[data-action="refresh-regex-display"]').click();
        return {
            text: document.querySelector('#messages .story-narrative')?.textContent || '',
            messages: app.store.activeSession.messages.map(message => ({ role: message.role, content: message.content })),
        };
    });
    await page.waitForTimeout(700);
    manualRefreshDisplay.iframeBodies = await page.evaluate(() => [...(document.querySelectorAll('#messages .story-narrative iframe') || [])].map(frame => frame.contentDocument?.body?.textContent || ''));
    console.log(JSON.stringify({ cardDisplay, manualRefreshDisplay }, null, 2));
    if (manualRefreshDisplay.text.includes('MODEL SECRET COT') || !manualRefreshDisplay.iframeBodies.some(text => text.includes('攻击'))) process.exitCode = 1;
} finally { await browser.close(); }
