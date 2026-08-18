import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

// Real-API retest for the BattleDeclaration hand-off prompt: the story model
// must freely emit participants, with a `state` for every entity and a
// `reference` for every source=existing entity.  This mirrors the reported
// high-frequency failures (/participants/N/state + /participants/N/reference).
const tempPath = 'C:/SillyTavern/vertex-master/temp.txt';
const presetPath = 'C:/Users/fengx/Downloads/Izumi 0503-RP用.json';
const outputPath = '.test/story-declaration-state-live.json';
const model = process.env.STORY_DECL_MODEL || 'gemini-3.7-flash';
const iterations = Number(process.env.STORY_DECL_ITER || 5);
const runTimeoutMs = Number(process.env.STORY_DECL_TIMEOUT_MS || 240000);
const temp = fs.readFileSync(tempPath, 'utf8');
const key = temp.match(/API-?Key\s*[=:：]\s*(\S+)/i)?.[1]?.trim() || temp.match(/API Key\s*[=:：]\s*(\S+)/i)?.[1]?.trim();
if (!key) throw new Error('temp.txt 中没有 API Key');
const preset = normalizePreset(JSON.parse(fs.readFileSync(presetPath, 'utf8')), 'Izumi 0503-RP用.json');

// Free-form: the model must pick participants itself, including an existing
// companion that needs `reference` and a `state` on every participant.
const scenario = `
酒馆打烊时分爆发冲突：你和旅伴正在二楼包厢清点战利品，楼下的佣兵头目带人堵住楼梯。对方扬言要抢走你们在废墟里找到的徽记。战斗已经开始，必须把这场战斗交给本地战术演算终端，不要替本地引擎计算命中、伤害、死亡或胜负。
请先写一小段正文，再在正文末尾输出唯一一个 BattleDeclaration 隐藏 JSON 块，严格包在 <BattleDeclaration> 与 </BattleDeclaration> 中，JSON 必须合法。声明至少包含 reason、battlefield(kind/shapeHint/description)、contactEstablished/contactPairs 和 participants；participants 至少包含一名 side=player、一名 side=enemy，且每个 participant 都必须写 state（大致状态、装备或威胁印象）与 relativePosition；对已有实体（你和旅伴）请使用 source=existing 并写 reference（引用 MVU 中的准确名称），对敌人使用 source=create。不要在块外输出 JSON，不要把坐标、HP、EP、攻击、防御、技能数值写进声明。
`;

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
const runs = [];
try {
    for (let index = 1; index <= iterations; index += 1) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        try {
            await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForFunction(() => window.__reincarnationApp?.runtime, null, { timeout: 60000 });
            const result = await Promise.race([
                page.evaluate(async ({ presetValue, keyValue, scenarioValue, modelValue }) => {
                    const app = window.__reincarnationApp;
                    app.runtime.setPreset(presetValue);
                    const existing = app.store.data.connections[0] || {};
                    const connection = app.store.saveConnection({
                        ...existing,
                        name: 'temp.txt story declaration state live test',
                        protocol: 'openai-chat',
                        baseUrl: 'http://127.0.0.1:2156/v1',
                        path: '/chat/completions',
                        model: modelValue,
                        apiKey: keyValue,
                        temperature: 0,
                        topP: 1,
                        maxTokens: 8000,
                        reasoningEffort: 'low',
                        extraHeaders: '{}',
                        extraBody: '{}',
                    });
                app.store.updateSettings({ aiAssignments: { ...(app.store.data.settings.aiAssignments || {}), storyConnectionId: connection.id } });
                const session = app.store.activeSession;
                const now = new Date().toISOString();
                session.messages = [
                    { id: 'decl-state-opening', role: 'assistant', content: '【酒馆冲突】', createdAt: now, swipes: ['【酒馆冲突】'], swipeIndex: 0 },
                    { id: 'decl-state-context', role: 'user', content: '你和旅伴正在二楼包厢清点战利品，佣兵头目带人堵住楼梯。', createdAt: now, swipes: ['你和旅伴正在二楼包厢清点战利品，佣兵头目带人堵住楼梯。'], swipeIndex: 0 },
                ];
                app.store.save();
                await app.generate({ text: scenarioValue });
                const assistant = app.store.activeSession.messages.at(-1);
                const content = String(assistant?.content || '');
                const match = content.match(/<BattleDeclaration\b[^>]*>([\s\S]*?)<\/BattleDeclaration\s*>/i);
                let declaration = null;
                let parseError = null;
                if (match) {
                    const raw = match[1].trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
                    try { declaration = JSON.parse(raw); } catch (error) { parseError = error.message; }
                }
                const validation = declaration ? await fetch('/api/combat/declaration/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ declaration }) }).then(response => response.json()) : null;
                const missingFields = [];
                if (declaration) for (const [idx, p] of (declaration.participants || []).entries()) {
                    if (!p?.state && !p?.condition && !p?.appearance) missingFields.push(`/participants/${idx}/state`);
                    if (p?.source === 'existing' && !p?.reference) missingFields.push(`/participants/${idx}/reference`);
                }
                return {
                    assistantId: assistant?.id || null,
                    responseChars: content.length,
                    responseHasDeclaration: Boolean(match),
                    declaration,
                    parseError,
                    validation,
                    missingFields,
                    participantCount: declaration?.participants?.length || 0,
                    sources: (declaration?.participants || []).map(p => `${p?.id}:${p?.source}:${p?.side}`),
                    response: content,
                };
            }, { presetValue: preset, keyValue: key, scenarioValue: scenario, modelValue: model }),
                new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), runTimeoutMs)),
            ]);
            runs.push({ index, ...result, pageErrors });
        } catch (error) {
            runs.push({ index, error: error.message, pageErrors });
        } finally {
            await page.close();
        }
    }
} finally {
    await browser.close();
}

const valid = runs.filter(run => run.responseHasDeclaration && run.validation?.ok === true && !run.pageErrors.length && !run.error);
const missingStateRef = runs.filter(run => run.responseHasDeclaration && (run.missingFields?.length || (run.validation?.errors || []).some(e => /state|reference/.test(e.path || ''))));
const report = {
    format: 'story-declaration-state-live-test',
    generatedAt: new Date().toISOString(),
    model,
    iterations: runs.length,
    validCount: valid.length,
    failureCount: runs.length - valid.length,
    missingStateRefCount: missingStateRef.length,
    runs: runs.map(run => ({
        index: run.index,
        responseHasDeclaration: run.responseHasDeclaration,
        parseError: run.parseError || null,
        validationOk: run.validation?.ok ?? null,
        validationErrorCount: run.validation?.errors?.length ?? null,
        validationErrors: (run.validation?.errors || []).slice(0, 6),
        missingFields: run.missingFields || [],
        participantCount: run.participantCount,
        sources: run.sources || [],
        pageErrors: run.pageErrors,
        error: run.error || null,
    })),
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
    model,
    iterations: runs.length,
    validCount: valid.length,
    failureCount: runs.length - valid.length,
    missingStateRefCount: missingStateRef.length,
    runs: runs.map(run => ({
        index: run.index,
        decl: run.responseHasDeclaration,
        parseError: run.parseError || null,
        valid: run.validation?.ok ?? null,
        errors: (run.validation?.errors || []).map(e => `${e.path}`).slice(0, 6),
        missing: run.missingFields || [],
        participants: run.participantCount,
        pageErrors: run.pageErrors,
        error: run.error || null,
    })),
    outputPath,
}, null, 2));
process.exitCode = runs.length - valid.length >= iterations / 2 ? 1 : 0;
