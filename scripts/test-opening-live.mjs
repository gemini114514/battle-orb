import { chromium } from 'playwright-core';

const context = await chromium.launchPersistentContext('C:\\SillyTavern\\reincarnation-web\\.test\\profile-copy-20260813', { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'], viewport: { width: 1440, height: 1000 } });
try {
    const page = context.pages()[0] || await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime && document.querySelectorAll('[data-starter-id]').length > 50);
    const limit = await page.evaluate(() => { const app = window.__reincarnationApp; const value = Math.max(30000, Number(app.runtime.activePreset?.sampling?.maxTokens || app.store.data.settings.maxTokens || 0)); app.runtime.activePreset.sampling.maxTokens = value; app.store.data.settings.maxTokens = value; return value; });
    await page.evaluate(() => window.__reincarnationApp.newSession()); await page.locator('[data-panel="chat"]').first().click();
    await page.locator('[data-cover-agree]').check(); await page.locator('[data-action="enter-game"]').click(); await page.getByRole('button', { name: '开始建档', exact: true }).click();
    await page.locator('#setupForm [name="name"]').fill('MVU实机首轮测试'); await page.locator('[data-attribute="体质"][data-delta="1"]').click(); await page.locator('[data-action="setup-next"]').click();
    await page.locator('[data-starter-id]').first().click(); await page.locator('[data-action="setup-next"]').click(); await page.locator('[data-action="setup-next"]').click();
    await page.locator('#setupForm [name="partnerEnabled"]').check(); await page.locator('#setupForm [name="partnerName"]').fill('MVU测试搭档'); await page.locator('#setupForm [name="partnerBackground"]').fill('与测试者一同进入主神空间的可靠同伴。'); await page.locator('[data-action="setup-next"]').click(); await page.locator('#setupForm').evaluate(form => form.requestSubmit());
    const prompt = await page.locator('#messageInput').inputValue();
    const before = await page.evaluate(() => structuredClone(window.__reincarnationApp.runtime.variables.stat_data));
    await page.evaluate(async value => window.__reincarnationApp.generate({ text: value }), prompt);
    const result = await page.evaluate(beforeData => {
        const app = window.__reincarnationApp; const answer = app.store.activeSession.messages.at(-1)?.content || ''; const current = app.runtime.variables;
        return { sessionId: app.store.activeSession.id, answerLength: answer.length, failed: answer.startsWith('> 连接中断'), updateBlocks: (answer.match(/<UpdateVariable>/gi) || []).length, jsonPatchBlocks: (answer.match(/<JSONPatch>/gi) || []).length, rootKeys: Object.keys(current), rogueMvuRoots: ['世界','任务','主角','资产','系统状态','关系列表','传闻','商城','设置','系统配置'].filter(key => key in current), initialBloodlineKept: Boolean(current.stat_data.主角.血统['人类血统']), finalConstitution: current.stat_data.主角.最终属性?.体质, itemCount: Object.keys(current.stat_data.主角.装备 || {}).length + Object.keys(current.stat_data.主角.道具 || {}).length + Object.keys(current.stat_data.主角.技能 || {}).length, partnerKept: current.stat_data.关系列表['MVU测试搭档']?.是否队友 === true, statChanged: JSON.stringify(beforeData) !== JSON.stringify(current.stat_data), variableSnapshots: app.store.activeSession.variableSnapshots.length };
    }, before);
    console.log(JSON.stringify({ outputLimit: limit, ...result, pageErrors: errors }, null, 2));
    if (limit < 30000 || result.failed || result.answerLength < 20 || result.updateBlocks < 1 || result.jsonPatchBlocks < 1 || result.rogueMvuRoots.length || !result.initialBloodlineKept || result.finalConstitution < 1 || !result.itemCount || !result.partnerKept || !result.statChanged || errors.length) process.exitCode = 1;
} finally { await context.close(); }
