import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { validateCombatModel } from '../combat/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const debugPath = 'C:\\Users\\fengx\\Downloads\\轮回战场-战术演算DEBUG-battle-0c03e490-ce0c-4503-aa73-8483442a66a6-2026-08-16T18-35-50-337Z.json';
const tempPath = 'C:\\SillyTavern\\vertex-master\\temp.txt';
const model = process.env.COMBAT_AI_MODEL || 'gemini-3.5-flash';
const temperature = Number(process.env.COMBAT_AI_TEMPERATURE || 0.2);
const callCount = Math.max(1, Number(process.env.COMBAT_AI_CALLS || 20));

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function reservePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
    });
}
function readApiKey() {
    const match = fs.readFileSync(tempPath, 'utf8').match(/API Key：([^\s]+)/);
    if (!match) throw new Error('temp.txt 中没有 API Key');
    return match[1];
}
function extractJson(text) {
    const source = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const start = source.indexOf('{');
    if (start < 0) throw new Error('回复中没有 JSON 对象');
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
        if (char === '"') { inString = true; continue; }
        if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) { end = index; break; }
    }
    if (end < 0) throw new Error('JSON 对象未闭合');
    return JSON.parse(source.slice(start, end + 1));
}
function semanticErrors(modelValue, context) {
    const errors = [];
    const participants = context.declaration.participants || [];
    const units = modelValue?.combatants || [];
    for (const participant of participants) {
        const matches = units.filter(unit => String(unit?.declarationId) === String(participant.id));
        if (matches.length !== 1) errors.push({ code: 'semantic.participant_one_to_one', path: '/combatants', message: `${participant.id} 必须恰好一个群体模板` });
        else if (Number(matches[0].count || 1) !== Number(participant.count || 1)) errors.push({ code: 'semantic.count_mismatch', path: '/combatants', message: `${participant.id} count 不一致` });
    }
    for (const required of context.requiredAssets || []) {
        const profile = (modelValue.assetProfiles || []).find(item => item.assetId === required.assetId);
        if (!profile || profile.fingerprint !== required.fingerprint || JSON.stringify(profile.finalAttributes || {}) !== JSON.stringify(required.finalAttributes || {})) errors.push({ code: 'semantic.asset_identity_mismatch', path: '/assetProfiles', message: `资产 ${required.assetId} 未逐字镜像` });
    }
    return errors;
}
function participantFromUnit(unit, index) {
    const count = Math.max(1, Number(unit.count || 1));
    const declarationId = String(unit.declarationId || unit.id || `participant-${index + 1}`).replace(/-\d{3}$/, '');
    const isPlayer = unit.side === 'player';
    const archetype = unit.tacticalProfile?.archetype || (unit.distribution?.style === 'scattered' ? 'scattered' : 'squad');
    return {
        id: declarationId,
        name: String(unit.name || declarationId).replace(/\s+\d+$/, ''),
        count,
        side: unit.side || 'enemy',
        source: isPlayer ? 'existing' : 'create',
        ...(isPlayer ? { reference: String(unit.name || declarationId) } : {}),
        state: isPlayer ? '来自真实 MVU 的当前可战斗状态与已装备战斗资产' : '来自真实战斗记录的敌对实体模板，状态按记录保留',
        lifeLevel: unit.lifeLevel || 'Ⅰ',
        attributeQualities: unit.attributeQualities || unit.qualityProfile || { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' },
        relativePosition: `真实记录坐标附近 (${Number(unit.position?.x || 0)},${Number(unit.position?.y || 0)})`,
        distribution: unit.distribution || { style: archetype === 'scattered' ? 'scattered' : 'squad', radiusMeters: 3, spacingMeters: 1.5, jitterMeters: 0.2, orientationDegrees: 0 },
    };
}
function buildRealContext() {
    const debug = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
    const sessionTrace = (debug.clientTrace || []).find(item => item.path === '/sessions' && item.request?.encounter);
    assert(sessionTrace?.request?.encounter, '战术 DEBUG 中没有真实 /sessions 请求');
    const encounter = sessionTrace.request.encounter;
    const declaration = {
        schema: 'vibe-combat-declaration/v3',
        worldLifeLevel: encounter.worldLifeLevel || 'Ⅱ',
        contactEstablished: encounter.contactEstablished === true,
        contactPairs: encounter.contactPairs || [],
        reason: encounter.title || '真实战术演算记录重建',
        battlefield: { kind: encounter.location || '真实战场', shapeHint: encounter.battlefield?.shape || 'rectangle', description: encounter.location || '' },
        participants: (encounter.combatants || []).map(participantFromUnit),
    };
    const knownEntities = (encounter.combatants || []).map(unit => ({
        id: unit.declarationId || unit.id, name: unit.name, side: unit.side, count: unit.count || 1,
        lifeLevel: unit.lifeLevel, attributeQualities: unit.attributeQualities || unit.qualityProfile,
        mvu: unit.side === 'player' ? unit.mvu || null : null, assetBindings: unit.assetBindings || [],
    }));
    const requiredAssets = (encounter.assetProfiles || []).map(asset => ({
        assetId: asset.assetId, fingerprint: asset.fingerprint, kind: asset.kind, name: asset.name,
        finalAttributes: asset.finalAttributes || {}, combat: asset.combat || {},
    }));
    return {
        declaration,
        knownEntities,
        requiredAssets,
        rules: { version: 'vibe-combat-v2-turn-field', spatial: 'only boundary, circles, distance, movement; no cover/terrain/pathfinding' },
    };
}
async function waitHealth(origin) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('本地测试服务器未启动');
}
async function callVertex(apiKey, systemPrompt, userPrompt, index) {
    const started = Date.now();
    const response = await fetch('http://127.0.0.1:2156/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature, max_tokens: 30000, stream: false, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
        signal: AbortSignal.timeout(320_000),
    });
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content || '';
    return { index, durationMs: Date.now() - started, status: response.status, content, usage: body.usage || null, error: response.ok ? null : body.error || body };
}

const apiKey = readApiKey();
const context = buildRealContext();
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
let browser;
const results = [];
const reportPath = path.join(root, '.test', `combat-ai-20-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
try {
    await waitHealth(origin);
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp?.combatModelPrompt);
    const systemPrompt = await page.evaluate(() => window.__reincarnationApp.combatModelPrompt());
    const userPrompt = JSON.stringify(context, null, 2);
    for (let index = 1; index <= callCount; index += 1) {
        let result;
        try {
            result = await callVertex(apiKey, systemPrompt, userPrompt, index);
            if (result.error) result.validation = { ok: false, errors: [{ code: 'http.error', path: '/', message: JSON.stringify(result.error) }] };
            else {
                try {
                    result.parsed = extractJson(result.content);
                    const structural = validateCombatModel(result.parsed, { declaration: context.declaration, requiredAssets: context.requiredAssets, strict: true });
                    const semantic = semanticErrors(result.parsed, context);
                    result.validation = { ...structural, ok: structural.ok && semantic.length === 0, errors: [...structural.errors, ...semantic] };
                } catch (error) { result.validation = { ok: false, errors: [{ code: 'parse.error', path: '/', message: error.message }] }; }
            }
        } catch (error) { result = { index, durationMs: 0, status: 0, content: '', usage: null, error: { message: error.message }, validation: { ok: false, errors: [{ code: 'request.error', path: '/', message: error.message }] } }; }
        results.push(result);
        const codes = (result.validation?.errors || []).map(item => item.code);
        console.log(JSON.stringify({ call: index, status: result.status, durationMs: result.durationMs, valid: result.validation?.ok === true, errorCodes: codes }));
    }
    const validCount = results.filter(item => item.validation?.ok === true).length;
    const errorCodes = {};
    for (const item of results) for (const error of item.validation?.errors || []) errorCodes[error.code] = (errorCodes[error.code] || 0) + 1;
    const report = { format: 'combat-ai-20-live-prompt-eval', createdAt: new Date().toISOString(), sourceDebug: debugPath, model, temperature, callCount, promptHash: hash(systemPrompt), contextHash: hash(context), context, systemPrompt, summary: { validCount, invalidCount: callCount - validCount, errorCodes }, results };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: validCount === callCount, reportPath, model, temperature, callCount, validCount, invalidCount: callCount - validCount, errorCodes }, null, 2));
    if (validCount < callCount) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); }
