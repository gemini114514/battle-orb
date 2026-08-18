import { chromium } from 'playwright-core';

const profile = 'C:\\SillyTavern\\reincarnation-web\\.test\\profile-copy-20260813';
const context = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
    args: ['--no-proxy-server'], viewport: { width: 1440, height: 1000 },
});

const fallback = [
    '我仔细观察主神空间，确认当前状态、可用资源与下一步选择。',
    '我选择最适合新人的第一个任务世界，并询问任务目标、失败条件与奖励。',
    '在投放前，我检查装备和能力，制定一个稳健但不拖延的行动计划。',
    '确认投放。我保持警戒，进入任务世界后先寻找安全位置并观察周围环境。',
    '我调查最近的异常迹象，优先收集能验证任务主线的线索。',
    '我尝试与遇到的关键人物交涉，隐藏主神空间情报，同时判断对方立场。',
    '根据已有线索，我采取风险可控的主动行动推进目标；如需检定请按规则完整裁定。',
    '我检查伤势、资源、任务进度和世界变化，然后处理当前最紧迫的威胁。',
    '我复盘刚才行动造成的后果，并选择能最大化生存率与任务收益的下一步。',
];

try {
    const page = context.pages()[0] || await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime && window.__reincarnationApp.presets().length, null, { timeout: 60000 });
    const config = await page.evaluate(() => { const app = window.__reincarnationApp; return { key: Boolean(app.store.data.settings.apiKey), model: Boolean(app.store.data.settings.model), preset: Boolean(app.runtime.activePreset) }; });
    if (!config.key || !config.model || !config.preset) throw new Error('隔离测试配置不完整');
    const outputLimit = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const configured = Number(app.runtime.activePreset?.sampling?.maxTokens || app.store.data.settings.maxTokens || 0);
        const fullLimit = Math.max(30000, configured);
        app.runtime.activePreset.sampling.maxTokens = fullLimit;
        app.store.data.settings.maxTokens = fullLimit;
        return fullLimit;
    });
    console.log(JSON.stringify({ fullOutputTokenLimit: outputLimit }));

    let state = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const candidates = app.store.data.sessions.filter(item => item.variables?.stat_data?.['主角']?.['姓名'] === '黑盒测试员·零').sort((a, b) => b.messages.filter(message => message.role === 'user').length - a.messages.filter(message => message.role === 'user').length);
        const session = candidates[0];
        if (!session) return null;
        app.store.selectSession(session.id);
        const last = session.messages.at(-1);
        if (last?.role === 'assistant' && (!last.content || last.content.startsWith('> 连接中断'))) { session.messages.pop(); app.store.save(); }
        const completed = session.messages.filter((message, index) => message.role === 'user' && session.messages.slice(index + 1).some(next => next.role === 'assistant' && next.content && !next.content.startsWith('> 连接中断'))).length;
        return { sessionId: session.id, completed, hasPendingUser: session.messages.at(-1)?.role === 'user' };
    });
    let opening = '';
    if (!state) {
        await page.evaluate(() => window.__reincarnationApp.newSession());
        await page.locator('[data-panel="chat"]').first().click();
        await page.locator('[data-cover-agree]').check();
        await page.locator('[data-action="enter-game"]').click();
        await page.getByRole('button', { name: '开始建档', exact: true }).click();
        await page.locator('#setupForm [name="name"]').fill('黑盒测试员·零');
        await page.locator('#setupForm [name="age"]').fill('24');
        await page.locator('#setupForm [name="faction"][value="执行者"]').check();
        await page.locator('[data-action="setup-next"]').click();
        for (const key of ['力量', '敏捷', '体质', '精神', '魅力', '敏捷', '体质', '精神']) await page.locator(`[data-attribute="${key}"][data-delta="1"]`).click();
        await page.locator('#setupForm [name="loadout"]').fill('短刀、急救包、便携照明；偏向侦察、生存与交涉。');
        await page.locator('[data-action="setup-next"]').click();
        await page.locator('#setupForm [name="background"]').fill('来自现代城市的应急救援志愿者，谨慎、重视证据，但在同伴遇险时会主动承担风险。');
        await page.locator('#setupForm').evaluate(form => form.requestSubmit());
        opening = await page.locator('#messageInput').inputValue();
        state = { completed: 0, hasPendingUser: false };
    }
    console.log(JSON.stringify({ resume: state }));

    const turnResults = [];
    for (let index = state.completed; index < 10; index++) {
        const pending = await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.at(-1)?.role === 'user');
        let prompt = pending ? await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.at(-1).content) : index === 0 ? opening : await page.evaluate(fallbackText => {
            const choices = [...document.querySelectorAll('[data-native-prompt]')].filter(node => node.offsetParent !== null);
            const choice = choices.at(-1)?.dataset.nativePrompt;
            return choice && choice.length > 8 ? choice : fallbackText;
        }, fallback[index - 1]);
        const before = await page.evaluate(() => window.__reincarnationApp.store.activeSession.messages.length);
        await page.evaluate(async ({ value, addUser }) => { await window.__reincarnationApp.generate({ text: value, addUser }); }, { value: prompt, addUser: !pending });
        const result = await page.evaluate(beforeCount => {
            const app = window.__reincarnationApp; const messages = app.store.activeSession.messages;
            const answer = messages.at(-1)?.content || '';
            return { messageDelta: messages.length - beforeCount, answerLength: answer.length, failed: answer.startsWith('> 连接中断'), hasVariableUpdate: /<UpdateVariable>/i.test(answer), hasOptions: /<options>|<mission>/i.test(answer), sessionId: app.store.activeSession.id };
        }, before);
        turnResults.push({ turn: index + 1, ...result });
        console.log(JSON.stringify(turnResults.at(-1)));
        if (result.failed || result.answerLength < 20) throw new Error(`第 ${index + 1} 轮生成不可用`);
    }
    const summary = await page.evaluate(async () => {
        const app = window.__reincarnationApp; const events = await app.blackbox.events();
        const completed = events.filter(item => item.type === 'generation_completed');
        const failed = events.filter(item => item.type === 'generation_failed');
        return { sessionId: app.store.activeSession.id, userTurns: app.store.activeSession.messages.filter(item => item.role === 'user').length, assistantTurns: app.store.activeSession.messages.filter(item => item.role === 'assistant' && item.content && !item.content.startsWith('> 连接中断')).length - 1, blackboxEvents: events.length, completedInRun: completed.length, failedInRun: failed.length, finalVariableBytes: JSON.stringify(app.runtime.variables).length };
    });
    console.log(JSON.stringify({ summary, turnResults, pageErrors: errors }, null, 2));
    if (summary.userTurns < 10 || summary.assistantTurns < 10 || summary.failedInRun || errors.length) process.exitCode = 1;
} finally { await context.close(); }
