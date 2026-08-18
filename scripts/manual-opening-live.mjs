import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const rawPreset = JSON.parse(fs.readFileSync('C:/Users/fengx/Downloads/Izumi 0503-RP用.json', 'utf8'));
const preset = normalizePreset(rawPreset, 'Izumi 0503-RP用.json');
const temp = fs.readFileSync('C:/SillyTavern/vertex-master/temp.txt', 'utf8');
const key = temp.match(/API Key\s*[=:：]\s*(\S+)/i)?.[1]?.trim();
if (!key) throw new Error('temp.txt 中没有 API Key');

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const prompt = await page.evaluate(input => {
        const runtime = window.__reincarnationApp.runtime;
        runtime.setPreset(input);
        return runtime.buildPrompt([{ role: 'assistant', content: '【开局】' }]).messages;
    }, preset);
    const payload = {
        model: 'gemini-3.7-flash',
        messages: prompt,
        temperature: 1,
        top_p: 0.99,
        max_tokens: 30000,
        frequency_penalty: 0,
        presence_penalty: 0,
        stream: false,
    };
    const response = await fetch('http://127.0.0.1:2156/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* report status only */ }
    const content = String(body?.choices?.[0]?.message?.content ?? '');
    const visible = content
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
        .replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[{}\[\]":,]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    console.log(JSON.stringify({
        status: response.status,
        ok: response.ok,
        model: body?.model ?? null,
        promptMessages: prompt.length,
        promptRoles: prompt.map(item => item.role),
        promptHasContinuationNudge: prompt.some(item => /Continue the following message/i.test(String(item.content))),
        responseChars: content.length,
        responseHasUpdate: /<UpdateVariable>/i.test(content),
        responseHasProseAfterMvuRemoval: visible.length > 0,
        visibleCharsAfterMvuRemoval: visible.length,
        responseHasContinuationNudge: /Continue the following message/i.test(content),
        responsePrefix: content.slice(0, 160),
        error: body?.error?.message ?? null,
    }, null, 2));
    if (!response.ok || prompt.some(item => /Continue the following message/i.test(String(item.content)))) process.exitCode = 1;
} finally {
    await browser.close();
}
