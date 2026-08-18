import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const preset = normalizePreset(JSON.parse(fs.readFileSync('C:/Users/fengx/Downloads/Izumi 0503-RP用.json', 'utf8')), 'Izumi 0503-RP用.json');
const blackbox = JSON.parse(fs.readFileSync('C:/Users/fengx/Downloads/轮回战场-黑盒-2026-08-15T19-11-15-318Z.json', 'utf8'));

function findDmResponse(value) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (const item of value) { const hit = findDmResponse(item); if (hit) return hit; }
        return null;
    }
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /^(content|response|aiResponse)$/i.test(key) && /<dm_think[ >]/i.test(item)) return item;
        const hit = findDmResponse(item); if (hit) return hit;
    }
    return null;
}

const dmResponse = findDmResponse(blackbox) || '<dm_think>SECRET</dm_think>正文';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const result = await page.evaluate(({ preset, dmResponse }) => {
        const app = window.__reincarnationApp;
        document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item.id === 'view-chat'));
        app.runtime.setPreset(preset);
        app.runtime.setRegexPresets([]);
        app.store.activeSession.messages = [{ id: 'izumi-dm-regex', role: 'assistant', content: dmResponse, createdAt: Date.now() }];
        app.store.save();
        app.renderAll();
        return { regexCount: app.runtime.regexScripts().length, presetRegexCount: preset.regexScripts?.length || 0 };
    }, { preset, dmResponse });
    await page.waitForTimeout(900);
    const display = await page.evaluate(() => {
        const body = document.querySelector('#messages .story-narrative');
        const frames = [...(body?.querySelectorAll('iframe.tavern-html-frame') || [])];
        return {
            parentText: body?.innerText || '',
            parentHtml: body?.innerHTML || '',
            frameCount: frames.length,
            frameText: frames.map(frame => frame.contentDocument?.body?.innerText || ''),
        };
    });
    const cotFallback = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        app.store.activeSession.messages = [{ id: 'izumi-cot-regex', role: 'assistant', content: '<cot>SECRET_COT</cot>可见正文', createdAt: Date.now() }];
        app.store.save(); app.renderAll();
        return document.querySelector('#messages .story-narrative')?.innerText || '';
    });
    const compact = {
        presetRegexCount: result.presetRegexCount,
        runtimeRegexCount: result.regexCount,
        dmResponseChars: dmResponse.length,
        dmTagVisible: /<dm_think\b|SECRET_COT|Step\.0 Receipt Check/i.test(`${display.parentText}\n${display.parentHtml}`),
        htmlFrameCount: display.frameCount,
        htmlFrameHasCheck: display.frameText.some(text => text.includes('CheckResult') || text.includes('命中') || text.includes('攻击')),
        cotFallbackVisible: /SECRET_COT/.test(cotFallback),
        proseVisible: cotFallback.includes('可见正文'),
        pageErrors,
    };
    console.log(JSON.stringify(compact, null, 2));
    if (compact.presetRegexCount !== 30 || compact.runtimeRegexCount < compact.presetRegexCount || compact.dmTagVisible || compact.cotFallbackVisible || !compact.proseVisible || pageErrors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
