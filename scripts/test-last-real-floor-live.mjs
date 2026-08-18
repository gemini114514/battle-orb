import fs from 'node:fs';
import { chromium } from 'playwright-core';

const temp = fs.readFileSync('C:/SillyTavern/vertex-master/temp.txt', 'utf8');
const key = temp.match(/API Key\s*[=:：]\s*(\S+)/i)?.[1]?.trim();
if (!key) throw new Error('temp.txt 中没有 API Key');

// This profile is a disposable snapshot of the user's real Chrome Profile 1
// captured before replay. Keep synthetic/demo profiles out of this test: the
// source message and variable snapshot must remain the real floor-4 branch.
const profile = process.env.REINCARNATION_REAL_PROFILE || 'C:/SillyTavern/reincarnation-web/.test/chrome-profile-real-0816';
const outputPath = '.test/last-real-floor-live.json';
const browser = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--profile-directory=Profile 1', '--no-proxy-server', '--disable-extensions'],
});

try {
    const page = browser.pages()[0] || await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__reincarnationApp?.store?.activeSession, null, { timeout: 60000 });
    const result = await page.evaluate(async keyValue => {
        const app = window.__reincarnationApp;
        const store = app.store;
        const session = store.activeSession;
        const original = structuredClone(session.messages);
        const targetAssistant = original.at(-1);
        const targetUser = original.at(-2);
        // Rewind only the real active branch to the exact pre-response state.
        // Snapshot messageIndex 6 is the persisted state after the real world
        // arrival and before the real user action "开始战斗" at index 7.
        const snapshot = [...(session.variableSnapshots || [])].reverse().find(item => Number(item.messageIndex) === 6);
        session.messages = original.slice(0, -1);
        if (snapshot?.variables) session.variables = structuredClone(snapshot.variables);
        const existing = store.data.connections.find(item => item.id === store.data.settings.aiAssignments?.storyConnectionId) || store.data.connections[0] || {};
        const connection = store.saveConnection({
            ...existing,
            name: '真实第4楼分支 · temp.txt 重放',
            protocol: 'openai-chat',
            baseUrl: 'http://127.0.0.1:2156/v1',
            path: '/v1/chat/completions',
            model: '假流式-gemini-3.7-flash',
            apiKey: keyValue,
            temperature: 0.9,
            topP: 0.99,
            maxTokens: 32768,
            reasoningEffort: 'auto',
            extraHeaders: '{}',
            extraBody: '{}',
        });
        store.updateSettings({ aiAssignments: { ...(store.data.settings.aiAssignments || {}), storyConnectionId: connection.id } });
        store.save();
        app.renderAll();
        await app.generate({ addUser: false, branchKey: 'real-floor-4-replay' });
        const assistant = store.activeSession.messages.at(-1);
        const trace = assistant?.promptTrace?.messages || [];
        const last = trace.at(-1);
        const lastText = String(last?.content || '');
        const content = String(assistant?.content || '');
        const visible = content
            .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return {
            source: {
                sessionId: session.id,
                messageCountBefore: original.length,
                targetUser: { id: targetUser?.id, role: targetUser?.role, content: targetUser?.content },
                targetAssistant: { id: targetAssistant?.id, role: targetAssistant?.role, content: targetAssistant?.content },
                snapshotMessageIndex: snapshot?.messageIndex ?? null,
            },
            replay: {
                model: connection.model,
                promptMessageCount: trace.length,
                promptRoles: trace.map(item => item.role),
                lastPrompt: lastText,
                lastPromptHasRealAction: lastText.includes('开始战斗'),
                lastPromptHasNarrativeBoundary: lastText.includes('[剧情输出边界]'),
                lastPromptHasContinueNudge: /Continue the following message/i.test(lastText),
                systemHasBattleInstruction: trace.some(item => item.role === 'system' && /BattleDeclaration/.test(String(item.content || ''))),
                responseChars: content.length,
                visibleCharsAfterMvu: visible.length,
                onlyMvu: /^\s*<UpdateVariable>[\s\S]*<\/UpdateVariable>\s*$/i.test(content),
                hasBattleDeclaration: /<BattleDeclaration\b/i.test(content),
                response: content,
                promptMessages: trace,
            },
        };
    }, key);
    const report = { format: 'real-floor-4-live-replay', generatedAt: new Date().toISOString(), profile, pageErrors, ...result };
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
        outputPath,
        pageErrors,
        source: report.source,
        replay: {
            model: report.replay.model,
            promptMessageCount: report.replay.promptMessageCount,
            lastPromptHasRealAction: report.replay.lastPromptHasRealAction,
            lastPromptHasNarrativeBoundary: report.replay.lastPromptHasNarrativeBoundary,
            lastPromptHasContinueNudge: report.replay.lastPromptHasContinueNudge,
            systemHasBattleInstruction: report.replay.systemHasBattleInstruction,
            responseChars: report.replay.responseChars,
            visibleCharsAfterMvu: report.replay.visibleCharsAfterMvu,
            onlyMvu: report.replay.onlyMvu,
            hasBattleDeclaration: report.replay.hasBattleDeclaration,
        },
    }, null, 2));
    if (pageErrors.length || !report.replay.lastPromptHasRealAction || !report.replay.lastPromptHasNarrativeBoundary || report.replay.onlyMvu) process.exitCode = 1;
} finally {
    await browser.close();
}
