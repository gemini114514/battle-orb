import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const preset = normalizePreset(JSON.parse(fs.readFileSync('C:/Users/fengx/Downloads/Izumi 0503-RP用.json', 'utf8')), 'Izumi 0503-RP用.json');
const temp = fs.readFileSync('C:/SillyTavern/vertex-master/temp.txt', 'utf8');
const key = temp.match(/API Key\s*[=:：]\s*(\S+)/i)?.[1]?.trim();
if (!key) throw new Error('temp.txt 中没有 API Key');

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const result = await page.evaluate(async ({ preset, key }) => {
        const app = window.__reincarnationApp;
        app.runtime.setPreset(preset);
        const existing = app.store.data.connections[0] || {};
        const connection = app.store.saveConnection({
            ...existing,
            name: 'temp.txt live reroll',
            protocol: 'openai-chat',
            baseUrl: 'http://127.0.0.1:2156/v1',
            path: '/chat/completions',
            model: 'gemini-3.7-flash',
            apiKey: key,
            temperature: 1,
            topP: 0.99,
            maxTokens: 30000,
            reasoningEffort: 'auto',
            extraHeaders: '{}',
            extraBody: '{}',
        });
        app.store.updateSettings({ aiAssignments: { ...(app.store.data.settings.aiAssignments || {}), storyConnectionId: connection.id } });
        const session = app.store.activeSession;
        const now = new Date().toISOString();
        session.messages = [
            { id: 'live-open', role: 'assistant', content: '开场场景已经展开。', createdAt: now, swipes: ['开场场景已经展开。'], swipeIndex: 0 },
            { id: 'live-action', role: 'user', content: '我先观察环境并确认身上的装备，然后谨慎地向前探索。', createdAt: now, swipes: ['我先观察环境并确认身上的装备，然后谨慎地向前探索。'], swipeIndex: 0 },
            { id: 'live-floor', role: 'assistant', content: '艾莉丝观察四周，确认空间平静，随后握紧装备准备继续前进。\n\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>', createdAt: now, swipes: [], swipeIndex: 0 },
        ];
        app.store.save();
        app.renderAll();
        const branch = app.store.forkStoryBranch('live-floor', 'temp.txt 实机重演');
        await app.generate({ addUser: false, branchKey: branch.forkKey });
        const answer = String(app.store.activeSession.messages.at(-1)?.content || '');
        const visible = answer
            .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
            .replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const promptMessages = app.store.activeSession.messages.at(-1)?.promptTrace?.messages || [];
        const lastPrompt = promptMessages.at(-1);
        return {
            model: connection.model,
            answerChars: answer.length,
            visibleCharsAfterMvuRemoval: visible.length,
            hasUpdateVariable: /<UpdateVariable>/i.test(answer),
            hasJsonPatch: /<JSONPatch>/i.test(answer),
            hasOnlyMvuAfterTrim: /^<UpdateVariable>[\s\S]*<\/UpdateVariable>\s*$/i.test(answer),
            lastPromptRole: lastPrompt?.role || null,
            lastPromptChars: String(lastPrompt?.content || '').length,
            lastPromptHasLiteralLastChatMacro: String(lastPrompt?.content || '').includes('{{lastChatMessage}}'),
            lastPromptHasContinue: /Continue the following message/i.test(String(lastPrompt?.content || '')),
            branchCount: app.store.storyBranches().length,
        };
    }, { preset, key });
    console.log(JSON.stringify({ ...result, pageErrors: errors }, null, 2));
    if (result.hasOnlyMvuAfterTrim || result.visibleCharsAfterMvuRemoval === 0 || result.lastPromptHasLiteralLastChatMacro || errors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
