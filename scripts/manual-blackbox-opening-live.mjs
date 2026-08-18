import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const blackbox = JSON.parse(fs.readFileSync('C:/Users/fengx/Downloads/轮回战场-黑盒-2026-08-15T19-11-15-318Z.json', 'utf8'));
const generation = blackbox.events.find(event => event.type === 'generation_started');
const setupPrompt = String(generation?.payload?.userText || '');
if (!setupPrompt) throw new Error('黑盒中没有 generation_started.payload.userText');
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
    const result = await page.evaluate(async ({ preset, key, setupPrompt }) => {
        const app = window.__reincarnationApp;
        app.runtime.setPreset(preset);
        const existing = app.store.data.connections[0] || {};
        const connection = app.store.saveConnection({ ...existing, name: 'blackbox opening live', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:2156/v1', path: '/chat/completions', model: 'gemini-3.7-flash', apiKey: key, temperature: 1, topP: .99, maxTokens: 30000, reasoningEffort: 'auto', extraHeaders: '{}', extraBody: '{}' });
        app.store.updateSettings({ aiAssignments: { ...(app.store.data.settings.aiAssignments || {}), storyConnectionId: connection.id } });
        const session = app.store.activeSession;
        const now = new Date().toISOString();
        session.messages = [{ id: 'blackbox-opening', role: 'assistant', content: '【开局】', createdAt: now, swipes: ['【开局】'], swipeIndex: 0 }];
        app.store.save();
        await app.generate({ text: setupPrompt });
        const answer = String(app.store.activeSession.messages.at(-1)?.content || '');
        const visible = answer.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '').replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const assistant = app.store.activeSession.messages.at(-1);
        const promptMessages = assistant?.promptTrace?.messages || [];
        const last = promptMessages.at(-1);
        const lastPrompt = String(last?.content || '');
        return { answerChars: answer.length, visibleCharsAfterMvuRemoval: visible.length, hasUpdateVariable: /<UpdateVariable>/i.test(answer), hasJsonPatch: /<JSONPatch>/i.test(answer), onlyMvu: /^<UpdateVariable>[\s\S]*<\/UpdateVariable>\s*$/i.test(answer), lastPromptRole: last?.role || null, lastPromptChars: lastPrompt.length, lastPromptStartsWithSubmittedInput: lastPrompt.startsWith(setupPrompt), hasNarrativeBoundary: /绝不能只返回变量块/.test(lastPrompt), promptMessageCount: promptMessages.length };
    }, { preset, key, setupPrompt });
    console.log(JSON.stringify({ ...result, setupPromptChars: setupPrompt.length, pageErrors: errors }, null, 2));
    if (result.onlyMvu || result.visibleCharsAfterMvuRemoval === 0 || !result.lastPromptStartsWithSubmittedInput || !result.hasNarrativeBoundary || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
