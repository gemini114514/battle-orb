import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCharacterCard } from './lib/card.js';
import vm from 'node:vm';
import YAML from 'yaml';
import { createCombatRouter } from './combat/router.js';
import { generateShopDraft, lifeLevelRoman, mergeApiCatalog, normalizeCatalog, normalizeLifeLevel, normalizeTarget, shopModelPrompt, tavernShopUserPrompt } from './shop/engine.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const cardPath = path.join(root, 'card', 'V3.2.6.png');
const app = express();
// Keep the old variable as a short-lived compatibility fallback for copied
// regression scripts; all user-facing configuration uses BATTLE_ORB_PORT.
const port = Number(process.env.BATTLE_ORB_PORT || process.env.REINCARNATION_PORT || 4175);
let appVersion = '0.1.0';
try { appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || appVersion; } catch { /* keep default */ }
const MAX_UPSTREAM_CONCURRENCY = 4;
let activeUpstreamCalls = 0;
const upstreamQueue = [];

function acquireUpstreamSlot() {
    return new Promise(resolve => {
        const enter = () => { activeUpstreamCalls += 1; resolve(); };
        if (activeUpstreamCalls < MAX_UPSTREAM_CONCURRENCY) enter();
        else upstreamQueue.push(enter);
    });
}

function releaseUpstreamSlot() {
    activeUpstreamCalls = Math.max(0, activeUpstreamCalls - 1);
    upstreamQueue.shift()?.();
}

app.use(express.json({ limit: '8mb' }));
const combat = createCombatRouter(root);
app.use('/api/combat', combat.router);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/version', (_req, res) => res.json({ name: 'battle-orb', version: appVersion }));
app.post('/api/update', (_req, res) => {
    const bat = path.join(root, 'update.bat');
    if (!fs.existsSync(bat)) return res.status(400).json({ ok: false, error: '缺少 update.bat，请从仓库获取或手动更新' });
    res.json({ ok: true, message: '更新已开始，服务器将自动重启' });
    // Spawn the update script detached, then exit this server so the script can
    // rebuild and start the new version on the same port.
    setTimeout(() => {
        try {
            const child = spawn('cmd.exe', ['/c', bat], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
        } catch (error) { console.error('[update] 启动更新脚本失败', error); }
        setTimeout(() => process.exit(0), 1500);
    }, 400);
});
app.get('/api/card', (_req, res) => {
    try {
        res.json(readCharacterCard(cardPath));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/card/image', (_req, res) => res.sendFile(cardPath));

const OPENING_SOURCE = 'https://cdn.jsdelivr.net/gh/Unspoken-MomoTea/Battlefield-of-Reincarnation@2e80eb1bc1df68cda5ac3d25d41233b503990e37/dist/V20260812/%E5%BC%80%E5%B1%80.html';
let openingDataCache;

function extractObjectLiteral(source, marker) {
    const markerAt = source.indexOf(marker);
    const start = source.indexOf('{', markerAt);
    if (markerAt < 0 || start < 0) throw new Error(`远程开局缺少 ${marker}`);
    let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index], next = source[index + 1];
        if (lineComment) { if (char === '\n') lineComment = false; continue; }
        if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
        if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
        if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
        if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '{') depth += 1;
        if (char === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error('远程开局数据库对象不完整');
}

app.get('/api/opening-data', async (_req, res) => {
    try {
        if (!openingDataCache) {
            const response = await fetch(OPENING_SOURCE, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const html = await response.text();
            const raw = vm.runInNewContext(`(${extractObjectLiteral(html, 'const DB =')})`, Object.create(null), { timeout: 1000 });
            openingDataCache = JSON.parse(JSON.stringify({
                source: OPENING_SOURCE, version: 'V20260812', initSpaceCoins: raw.initSpaceCoins,
                attrBasePoints: raw.attrBasePoints, attributes: raw.attributes, equipTypes: raw.equipTypes,
                itemCategories: raw.itemCategories, rarityList: raw.rarityList, equipments: raw.equipments,
                items: raw.items, skills: raw.skills, factionInfo: raw.factionInfo,
                plotCategories: raw.plotCategories, plots: raw.plots,
            }));
        }
        res.json(openingDataCache);
    } catch (error) { res.status(502).json({ error: `加载卡片开局数据库失败：${error.message}` }); }
});

app.post('/api/import-script-url', async (req, res) => {
    try {
        const sourceUrl = new URL(String(req.body.url || '').trim());
        if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('脚本地址必须使用 http:// 或 https://');
        const upstream = await fetch(sourceUrl, { headers: { Accept: 'application/json,text/javascript,text/plain,*/*' }, signal: AbortSignal.timeout(60000) });
        if (!upstream.ok || !upstream.body) throw new Error(`远程服务器返回 ${upstream.status} ${upstream.statusText}`);
        const limit = 32 * 1024 * 1024;
        const declared = Number(upstream.headers.get('content-length') || 0);
        if (declared > limit) throw new Error('远程脚本超过 32 MB 限制');
        const chunks = []; let size = 0;
        const reader = upstream.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw new Error('远程脚本超过 32 MB 限制'); }
            chunks.push(Buffer.from(value));
        }
        const pathParts = sourceUrl.pathname.split('/').filter(Boolean).map(item => decodeURIComponent(item));
        const leaf = pathParts.at(-1) || '远程助手脚本.json';
        const filename = /^index\.(?:m?js|json)$/i.test(leaf) && pathParts.length > 1 ? `${pathParts.at(-2)}${leaf.slice(5)}` : leaf;
        res.json({ url: sourceUrl.href, filename, contentType: upstream.headers.get('content-type') || '', content: Buffer.concat(chunks).toString('utf8') });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

function endpoint(baseUrl, suffix) {
    const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    return clean.endsWith('/v1') ? `${clean}${suffix}` : `${clean}/v1${suffix}`;
}

function cleanBase(baseUrl) {
    const value = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(value)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    return value;
}

function customEndpoint(baseUrl, customPath, fallback) {
    const base = cleanBase(baseUrl);
    const route = String(customPath || fallback || '').trim();
    if (/^https?:\/\//i.test(route)) return route;
    for (const prefix of ['/v1beta', '/v1']) {
        if (base.toLowerCase().endsWith(prefix) && route.toLowerCase().startsWith(`${prefix}/`)) return `${base}${route.slice(prefix.length)}`;
    }
    return `${base.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`;
}

function jsonObject(value, label) {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label}不是有效 JSON 对象`);
    return parsed;
}

function providerHeaders(apiKey, extras = {}, base = {}) {
    const headers = { ...base, ...extras };
    if (apiKey && !Object.keys(headers).some(key => key.toLowerCase() === 'authorization') && !Object.keys(headers).some(key => key.toLowerCase() === 'x-api-key')) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function systemAndMessages(messages) {
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
    const chat = messages.filter(item => item.role !== 'system').map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content }));
    return { system, chat };
}

function openAiResponsesInput(messages) {
    return messages.map(item => ({ role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }] }));
}

function parseJsonObject(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(raw); } catch (_error) {
        const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('模型返回的商城内容不是有效 JSON');
        return JSON.parse(raw.slice(start, end + 1));
    }
}

function parseShopModelOutput(text) {
    const raw = String(text || '').trim().replace(/^```(?:ya?ml|json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!raw) throw new Error('商城模型未返回内容');
    try { return parseJsonObject(raw); } catch (_jsonError) {
        const parsed = YAML.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('模型返回的商城内容不是对象');
        return parsed;
    }
}

app.post('/api/models', async (req, res) => {
    try {
        const protocol = req.body.protocol || 'openai-chat';
        const base = cleanBase(req.body.baseUrl);
        const extras = jsonObject(req.body.extraHeaders, '额外请求头');
        let url;
        let headers = {};
        if (protocol === 'gemini') {
            url = customEndpoint(base, req.body.modelsPath, '/v1beta/models');
            url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(req.body.apiKey || '')}`;
            headers = extras;
        } else if (protocol === 'anthropic') {
            url = customEndpoint(base, req.body.modelsPath, '/v1/models');
            headers = { 'x-api-key': req.body.apiKey || '', 'anthropic-version': req.body.apiVersion || '2023-06-01', ...extras };
        } else {
            url = customEndpoint(base, req.body.modelsPath, '/v1/models');
            headers = providerHeaders(req.body.apiKey, extras);
        }
        const response = await fetch(url, { headers });
        const body = await response.text();
        if (!response.ok) return res.status(response.status).type('application/json').send(body);
        const parsed = JSON.parse(body);
        if (protocol === 'gemini') return res.json({ data: (parsed.models || []).filter(item => item.supportedGenerationMethods?.includes('generateContent')).map(item => ({ id: item.name.replace(/^models\//, '') })) });
        res.json(parsed);
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

function composeShopPromptMessages({ tavernShopSystem, prompt, promptOverride = '', promptModules = {} } = {}) {
    const modules = promptModules && typeof promptModules === 'object' ? promptModules : {};
    const preset = modules.preset && typeof modules.preset === 'object' ? modules.preset : {};
    const rules = modules.rules && typeof modules.rules === 'object' ? modules.rules : {};
    const work = modules.work && typeof modules.work === 'object' ? modules.work : {};
    const messages = [];
    if (preset.enabled !== false && String(preset.text || '').trim()) messages.push({ role: preset.role === 'assistant' ? 'assistant' : preset.role === 'user' ? 'user' : 'system', content: String(preset.text).trim() });
    if (rules.enabled !== false) {
        const rulesText = String(promptOverride || rules.text || tavernShopSystem || '你是严格的 JSON 商品文案填充器。只返回要求的 JSON，不要 markdown。').trim();
        if (rulesText) messages.push({ role: rules.role === 'user' ? 'user' : 'system', content: rulesText });
    }
    if (work.enabled !== false) {
        const workText = String(work.text || prompt || '').trim();
        if (workText) messages.push({ role: work.role === 'system' ? 'system' : work.role === 'assistant' ? 'assistant' : 'user', content: workText });
    }
    return messages;
}

app.post('/api/shop/prompt-preview', (req, res) => {
    try {
        const body = req.body || {};
        const toolArgs = body.args && typeof body.args === 'object' ? body.args : {};
        const tavernShopSystem = String(body.tavernShopSystem || '').trim();
        const characterName = String(body.characterName || body.playerName || '轮回者').trim().slice(0, 80) || '轮回者';
        const playerLevel = normalizeLifeLevel(body.playerLifeLevel || body.playerLevel || body.level || toolArgs.生命层级 || toolArgs.玩家等级 || body.hero?.层级 || body.hero?.位阶 || body.hero?.等级 || 1);
        const target = body.target && typeof body.target === 'object' ? body.target : {};
        const autonomousTarget = Boolean(target.autonomous || target.modelDecides || target.categories?.includes('all'));
        const slotPreferences = Array.isArray(body.slotPreferences) && body.slotPreferences.length ? body.slotPreferences : (Array.isArray(toolArgs.槽位偏好) ? toolArgs.槽位偏好 : (Array.isArray(target.slotPreferences) ? target.slotPreferences : []));
        const draft = generateShopDraft({ playerLevel, slotPreferences, target: autonomousTarget ? { ...target, categories: ['all'] } : target, seed: body.seed || `${characterName}:${playerLevel}:${JSON.stringify(target)}`, hero: body.hero || {}, currentCatalog: body.currentCatalog || {} });
        const prompt = tavernShopSystem
            ? tavernShopUserPrompt({ playerLevel: draft.playerLevel, characterName, hero: body.hero || {}, query: draft.target.query })
            : shopModelPrompt({ draft: draft.generated, target: autonomousTarget ? { ...draft.target, autonomous: true } : draft.target, playerLevel: draft.playerLevel, characterName, query: draft.target.query });
        const override = String(body.promptOverride || '').trim();
        const messages = composeShopPromptMessages({ tavernShopSystem, prompt, promptOverride: override, promptModules: body.promptModules });
        res.json({ ok: true, mode: tavernShopSystem ? 'tavern-v3.2.6-reference' : 'legacy-draft-filler', messages, draft: { target: draft.target, playerLevel: draft.playerLevel, playerLifeLevel: draft.playerLifeLevel, generated: draft.generated, rulesetVersion: draft.rulesetVersion, qualityPolicy: draft.qualityPolicy, priceRanges: draft.priceRanges }, overrideApplied: Boolean(override) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.post(['/api/shop/refresh', '/api/shop/forge'], async (req, res) => {
    const body = req.body || {};
    const toolArgs = body.args && typeof body.args === 'object' ? body.args : {};
    const connection = body.connection && typeof body.connection === 'object' ? body.connection : body;
    const tavernShopSystem = String(body.tavernShopSystem || '').trim();
    const tavernCompatible = tavernShopSystem.length > 0;
    const characterName = String(body.characterName || body.playerName || '轮回者').trim().slice(0, 80) || '轮回者';
    const shopController = new AbortController();
    const shopTimeout = setTimeout(() => shopController.abort(new Error('商城模型请求超过 300 秒')), 300000);
    res.on('close', () => { if (!res.writableEnded) shopController.abort(new Error('客户端取消商城刷新')); });
    try {
        const playerLevel = normalizeLifeLevel(body.playerLifeLevel || body.playerLevel || body.level || toolArgs.生命层级 || toolArgs.玩家等级 || body.hero?.层级 || body.hero?.位阶 || body.hero?.等级 || 1);
        const target = body.target && typeof body.target === 'object' ? body.target : {};
        const slotPreferences = Array.isArray(body.slotPreferences) && body.slotPreferences.length ? body.slotPreferences : (Array.isArray(toolArgs.槽位偏好) ? toolArgs.槽位偏好 : (Array.isArray(target.slotPreferences) && target.slotPreferences.length ? target.slotPreferences : (Array.isArray(target.slots) ? target.slots : [])));
        const autonomousTarget = Boolean(target.autonomous || target.modelDecides || target.categories?.includes('all'));
        const draft = generateShopDraft({
            playerLevel,
            slotPreferences,
            target: autonomousTarget ? { ...target, categories: ['all'] } : target,
            seed: body.seed || `${characterName}:${playerLevel}:${JSON.stringify(target)}`,
            hero: body.hero || {},
            currentCatalog: body.currentCatalog || {},
        });
        let catalog = draft.catalog;
        let effectiveDraft = draft;
        let source = 'local';
        const warnings = [];
        let apiTrace = null;
        const model = String(connection.model || '').trim();
        if (model && connection.baseUrl) {
            try {
                const prompt = tavernCompatible
                    ? tavernShopUserPrompt({ playerLevel: draft.playerLevel, characterName, hero: body.hero || {}, query: draft.target.query })
                    : shopModelPrompt({ draft: draft.generated, target: autonomousTarget ? { ...draft.target, autonomous: true } : draft.target, playerLevel: draft.playerLevel, characterName, query: draft.target.query });
                const override = String(body.promptOverride || '').trim();
                const upstreamMessages = composeShopPromptMessages({ tavernShopSystem: tavernShopSystem || '你是严格的 JSON 商品文案填充器。只返回要求的 JSON，不要 markdown。', prompt, promptOverride: override, promptModules: body.promptModules });
                apiTrace = {
                    model,
                    protocol: connection.protocol || 'openai-chat',
                    mode: tavernCompatible ? 'tavern-v3.2.6-reference' : 'legacy-draft-filler',
                    prompt,
                    system: upstreamMessages[0].content,
                    messages: upstreamMessages,
                };
                const upstream = await fetch(`http://127.0.0.1:${port}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...connection,
                        stream: false,
                        maxTokens: Math.max(30000, Number(connection.maxTokens) || 32768),
                        messages: upstreamMessages,
                    }),
                    signal: shopController.signal,
                });
                const responseBody = await upstream.json().catch(() => ({}));
                if (!upstream.ok) throw new Error(responseBody.error?.message || responseBody.error || `模型请求失败（${upstream.status}）`);
                const rawContent = responseBody.choices?.[0]?.message?.content || responseBody.output_text || '';
                const content = Array.isArray(rawContent) ? rawContent.map(item => typeof item === 'string' ? item : item?.text || '').join('') : rawContent;
                const responseCatalog = tavernCompatible ? parseShopModelOutput(content) : parseJsonObject(content);
                apiTrace.responseText = String(content).slice(0, 50000);
                apiTrace.response = responseCatalog;
                if (tavernCompatible) {
                    // The original forge_shop model generates the entire YAML
                    // catalogue.  Preserve that response verbatim apart from
                    // structural normalization for the web UI; do not repair
                    // prices, tiers, dice, or effects locally.
                    catalog = normalizeCatalog(responseCatalog);
                    effectiveDraft.target = draft.target;
                } else {
                    const modelSelection = responseCatalog.刷新目标 || responseCatalog.refreshTarget || responseCatalog.target || {};
                    const modelTarget = autonomousTarget ? normalizeTarget({ ...modelSelection, categories: modelSelection.categories || modelSelection.分类 || modelSelection.category || modelSelection.categories列表 }) : draft.target;
                    const selectedTarget = autonomousTarget && modelTarget.categories.length ? modelTarget : draft.target;
                    const targetChanged = selectedTarget.categories.join(',') !== draft.target.categories.join(',')
                        || selectedTarget.slots.join(',') !== draft.target.slots.join(',')
                        || selectedTarget.qualityPreferences.join(',') !== draft.target.qualityPreferences.join(',');
                    const selectedDraft = autonomousTarget && targetChanged ? generateShopDraft({ playerLevel, slotPreferences: selectedTarget.slots, target: selectedTarget, seed: body.seed, hero: body.hero || {}, currentCatalog: body.currentCatalog || {} }) : draft;
                    catalog = mergeApiCatalog(selectedDraft.catalog, responseCatalog, selectedTarget);
                    effectiveDraft = selectedDraft;
                    effectiveDraft.target = selectedTarget;
                }
                source = 'api';
                apiTrace.usage = responseBody.usage || responseBody.usageMetadata || null;
            } catch (error) {
                warnings.push(`API 文案填充失败，已使用本地规则草案：${error.message}`);
                if (apiTrace) apiTrace.error = error.message;
            }
        } else {
            warnings.push('未配置可用 API，已使用本地规则生成商品数值与占位文案');
        }
        const member = {};
        for (const key of ['血统列表', '形态列表', '技能列表', '装备列表', '道具列表', '升级列表']) member[key] = catalog[key];
        catalog.成员商库 = { ...(catalog.成员商库 || {}), [characterName]: member };
        const shopItems = ['升级列表', '形态列表', '技能列表', '血统列表', '装备列表', '道具列表'].flatMap(key => catalog[key] || []);
        res.json({
            ok: true,
            source,
            warnings,
            refreshId: `shop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            generatedAt: new Date().toISOString(),
            rulesetVersion: effectiveDraft.rulesetVersion,
            baseQuality: effectiveDraft.baseQuality,
            priceRange: effectiveDraft.priceRange,
            qualitySet: effectiveDraft.qualitySet,
            qualityPolicy: effectiveDraft.qualityPolicy,
            priceRanges: effectiveDraft.priceRanges,
            seed: effectiveDraft.seed,
            target: effectiveDraft.target,
            playerLevel: effectiveDraft.playerLevel,
            playerLifeLevel: lifeLevelRoman(effectiveDraft.playerLevel),
            // Card forge_shop returns a localized flat 商品列表. Keep that
            // compatibility view alongside the app's categorized catalogue.
            商品列表: shopItems,
            items: shopItems,
            catalog,
            mvuCompatible: { 商城: catalog, path: `/stat_data/商城/成员商库/${characterName}` },
            tool: 'forge_shop',
            apiTrace,
        });
    } catch (error) {
        if (!res.headersSent) res.status(error.name === 'AbortError' ? 499 : 400).json({ ok: false, error: error.message });
    } finally {
        clearTimeout(shopTimeout);
    }
});

app.post('/api/chat', async (req, res) => {
    const { baseUrl, apiKey, model, messages, temperature = 0.9, maxTokens = 32768, protocol = 'openai-chat', topP, topK, frequencyPenalty, presencePenalty, reasoningEffort, assistantPrefill, stream = true } = req.body;
    const upstreamController = new AbortController();
    let upstreamTimeout;
    const armUpstreamTimeout = phase => {
        clearTimeout(upstreamTimeout);
        upstreamTimeout = setTimeout(() => upstreamController.abort(new Error(`${phase}连续 300 秒无响应`)), 300000);
    };
    res.on('close', () => { if (!res.writableEnded) upstreamController.abort(new Error('客户端已断开')); });
    await acquireUpstreamSlot();
    armUpstreamTimeout('等待上游');
    try {
        if (!model) throw new Error('请先填写模型名称');
        const base = cleanBase(baseUrl);
        const extraHeaders = jsonObject(req.body.extraHeaders, '额外请求头');
        const extraBody = jsonObject(req.body.extraBody, '额外请求体');
        if (protocol === 'anthropic') {
            const { system, chat } = systemAndMessages(messages);
            if (assistantPrefill) chat.push({ role: 'assistant', content: assistantPrefill });
            const upstream = await fetch(customEndpoint(base, req.body.path, '/v1/messages'), {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': req.body.apiVersion || '2023-06-01', ...extraHeaders },
                body: JSON.stringify({ model, system, messages: chat, temperature, top_p: topP, top_k: topK, max_tokens: maxTokens, stream: false, ...extraBody }),
                signal: upstreamController.signal,
            });
            armUpstreamTimeout('接收响应');
            const data = await upstream.json();
            if (!upstream.ok) return res.status(upstream.status).json(data);
            return res.json({ choices: [{ message: { role: 'assistant', content: (data.content || []).filter(item => item.type === 'text').map(item => item.text).join('') } }], usage: data.usage });
        }
        if (protocol === 'gemini') {
            const { system, chat } = systemAndMessages(messages);
            const contents = chat.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] }));
            if (assistantPrefill) contents.push({ role: 'model', parts: [{ text: assistantPrefill }] });
            let route = String(req.body.path || '/v1beta/models/{model}:generateContent').replace('{model}', encodeURIComponent(model));
            const url = customEndpoint(base, route, route) + `${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey || '')}`;
            const upstream = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders },
                body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig: { temperature, topP, topK, maxOutputTokens: maxTokens }, ...extraBody }),
                signal: upstreamController.signal,
            });
            armUpstreamTimeout('接收响应');
            const data = await upstream.json();
            if (!upstream.ok) return res.status(upstream.status).json(data);
            const text = data.candidates?.[0]?.content?.parts?.map(item => item.text || '').join('') || '';
            return res.json({ choices: [{ message: { role: 'assistant', content: text } }], usage: data.usageMetadata });
        }
        if (protocol === 'openai-responses') {
            const upstream = await fetch(customEndpoint(base, req.body.path, '/v1/responses'), {
                method: 'POST', headers: providerHeaders(apiKey, extraHeaders, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ model, input: openAiResponsesInput(messages), temperature, top_p: topP, max_output_tokens: maxTokens, ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoning: { effort: reasoningEffort } } : {}), stream: false, ...extraBody }),
                signal: upstreamController.signal,
            });
            armUpstreamTimeout('接收响应');
            const data = await upstream.json();
            if (!upstream.ok) return res.status(upstream.status).json(data);
            const text = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
            return res.json({ choices: [{ message: { role: 'assistant', content: text } }], usage: data.usage });
        }
        const upstream = await fetch(customEndpoint(base, req.body.path, '/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...providerHeaders(apiKey, extraHeaders),
            },
            // Keep the wire body compatible with Tavern's node-fetch request.
            // Usage metadata is optional; adding stream_options changes the
            // request shape and is not needed for prompt/generation parity.
            body: JSON.stringify({ model, messages: assistantPrefill ? [...messages, { role: 'assistant', content: assistantPrefill }] : messages, temperature, top_p: topP, max_tokens: maxTokens, frequency_penalty: frequencyPenalty, presence_penalty: presencePenalty, ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoning_effort: reasoningEffort } : {}), stream, ...extraBody }),
            signal: upstreamController.signal,
        });
        armUpstreamTimeout('接收响应');
        if (!stream) {
            const data = await upstream.json();
            return res.status(upstream.status).json(data);
        }
        if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text();
            return res.status(upstream.status || 502).json({ error: detail || upstream.statusText });
        }
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = upstream.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            armUpstreamTimeout('流式传输');
            res.write(Buffer.from(value));
        }
        res.end();
    } catch (error) {
        if (!res.headersSent) res.status(502).json({ error: error.message });
        else res.end();
    } finally {
        clearTimeout(upstreamTimeout);
        releaseUpstreamSlot();
    }
});

if (!process.argv.includes('--api-only')) {
    const dist = path.join(root, 'dist');
    if (!fs.existsSync(dist)) {
        console.error('尚未构建前端，请先运行 npm run build');
        process.exit(1);
    }
    // The standalone client is frequently rebuilt while a local browser tab
    // remains open. Do not let Chromium keep an old index or hashed bundle
    // after a rebuild; the combat canvas must always match the source/tests.
    app.use(express.static(dist, { setHeaders: response => response.setHeader('Cache-Control', 'no-store, max-age=0') }));
    app.use((_req, res) => { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.sendFile(path.join(dist, 'index.html')); });
}

app.listen(port, '127.0.0.1', () => {
    console.log(`Battle Orb: http://127.0.0.1:${port}`);
});
