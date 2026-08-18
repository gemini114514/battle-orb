import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const sourcePath = 'C:/Users/fengx/Downloads/Izumi 0503-RP用.json';
const normalized = normalizePreset(JSON.parse(fs.readFileSync(sourcePath, 'utf8')), 'Izumi 0503-RP用.json');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
let captured = null;
const capturedRequests = [];
await page.route('**/api/chat', async route => {
    captured = JSON.parse(route.request().postData() || '{}');
    capturedRequests.push(captured);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'TEST_OK' } }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }) });
});
try {
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const result = await page.evaluate(async preset => {
        const app = window.__reincarnationApp;
        app.runtime.setPreset(preset);
        app.runtime.promptContext = { lastUserMessage: '上一条用户', lastMessage: '上一条模型' };
        const macro = app.runtime.macros('{{lastChatMessage}}');
        const prompt = app.runtime.buildPrompt([{ role: 'assistant', content: '【开局】' }]);
        const full = prompt.messages.map(message => message.content).join('\n');
        const marker = text => ({ index: full.indexOf(text), message: prompt.messages.findIndex(item => item.content.includes(text)) });
        const connection = app.store.data.connections[0];
        app.store.saveConnection({ ...connection, baseUrl: 'http://mock.test/v1', model: 'mock-model', reasoningEffort: 'auto' });
        const session = app.store.activeSession;
        session.messages = [];
        app.store.save();
        await app.generate({ addUser: false });
        return {
            macro,
            roles: prompt.messages.map(message => message.role),
            lastBuiltMessage: prompt.messages.at(-1),
            lastBuiltSummary: { role: prompt.messages.at(-1)?.role, chars: prompt.messages.at(-1)?.content?.length ?? 0, prefix: prompt.messages.at(-1)?.content?.slice(0, 40) ?? '' },
            format: marker('<Format>'),
            entity: marker('<entity_output>'),
            htmlEscaped: /&#(?:34|39|38|60|62);/.test(full),
            messagesAfterGenerate: session.messages.map(message => ({ role: message.role, content: message.content })),
        };
    }, normalized);
    const rerollResult = await page.evaluate(async () => {
        const app = window.__reincarnationApp;
        const session = app.store.activeSession;
        const now = new Date().toISOString();
        session.messages = [
            { id: 'reroll-open', role: 'assistant', content: '上一楼正文', createdAt: now, swipes: ['上一楼正文'], swipeIndex: 0 },
            { id: 'reroll-user', role: 'user', content: '我继续观察并前进。', createdAt: now, swipes: ['我继续观察并前进。'], swipeIndex: 0 },
            { id: 'reroll-floor', role: 'assistant', content: '待重演楼层', createdAt: now, swipes: ['待重演楼层'], swipeIndex: 0 },
        ];
        app.store.save();
        const branch = app.store.forkStoryBranch('reroll-floor', '回归重演');
        await app.generate({ addUser: false, branchKey: branch.forkKey });
        const assistant = app.store.activeSession.messages.at(-1);
        const prompt = assistant?.promptTrace?.messages || [];
        const last = prompt.at(-1);
        return {
            answer: assistant?.content || '',
            lastPrompt: String(last?.content || ''),
            lastRole: last?.role || null,
        };
    });
    const normalTurnResult = await page.evaluate(async () => {
        const app = window.__reincarnationApp;
        const session = app.store.activeSession;
        session.messages = [];
        app.store.save();
        const userText = '当前动作：展开开局场景并继续叙述。';
        await app.generate({ text: userText });
        const assistant = app.store.activeSession.messages.at(-1);
        const prompt = assistant?.promptTrace?.messages || [];
        const last = prompt.at(-1);
        return { userText, lastRole: last?.role || null, lastContent: String(last?.content || ''), answer: assistant?.content || '' };
    });
    const request = captured || {};
    const freshRequest = capturedRequests[0] || {};
    const freshRequestMessages = Array.isArray(freshRequest.messages) ? freshRequest.messages : [];
    const requestMessages = Array.isArray(request.messages) ? request.messages : [];
    const lastRequest = requestMessages.at(-1);
        const checks = {
            lastChatMessageMacro: result.macro === '上一条模型',
        freshBuildHasNoContinuationNudge: !result.lastBuiltMessage?.content?.includes('Continue the following message'),
        requestHasNoContinuationNudge: !freshRequestMessages.some(message => String(message.content).includes('Continue the following message')),
        noPresetReasoningEffort: request.reasoningEffort === 'auto',
        noStreamOptions: !Object.hasOwn(request, 'streamOptions'),
        worldbookEntityBeforeFormat: result.entity.index >= 0 && result.format.index >= 0 && result.entity.index < result.format.index,
        noHtmlEntityEscapes: !result.htmlEscaped,
        generatedMockReply: result.messagesAfterGenerate.at(-1)?.content === 'TEST_OK',
        rerollUsesContinuationNudge: rerollResult.lastRole === 'user' && /Continue the following message/i.test(rerollResult.lastPrompt),
        rerollExpandsLastChatMacro: !rerollResult.lastPrompt.includes('{{lastChatMessage}}'),
        rerollGeneratedReply: rerollResult.answer === 'TEST_OK',
        normalTurnEndsWithNarrativeBoundary: normalTurnResult.lastRole === 'user' && normalTurnResult.lastContent.startsWith(normalTurnResult.userText) && /绝不能只返回变量块/.test(normalTurnResult.lastContent),
        noPageErrors: pageErrors.length === 0,
    };
    console.log(JSON.stringify({ checks, reroll: { lastRole: rerollResult.lastRole, promptChars: rerollResult.lastPrompt.length, promptHasContinue: /Continue the following message/i.test(rerollResult.lastPrompt), promptHasLiteralMacro: rerollResult.lastPrompt.includes('{{lastChatMessage}}'), answerChars: rerollResult.answer.length }, normalTurn: { lastRole: normalTurnResult.lastRole, lastContentChars: normalTurnResult.lastContent.length, hasNarrativeBoundary: /绝不能只返回变量块/.test(normalTurnResult.lastContent), answerChars: normalTurnResult.answer.length }, result: { macro: result.macro, roles: result.roles, lastBuiltSummary: result.lastBuiltSummary, format: result.format, entity: result.entity, htmlEscaped: result.htmlEscaped, messagesAfterGenerate: result.messagesAfterGenerate.slice(-3) }, request: { keys: Object.keys(request), lastMessage: { role: lastRequest?.role, chars: String(lastRequest?.content ?? '').length, prefix: String(lastRequest?.content ?? '').slice(0, 40) }, messageCount: requestMessages.length }, pageErrors }, null, 2));
    if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally {
    await context.close();
    await browser.close();
}
