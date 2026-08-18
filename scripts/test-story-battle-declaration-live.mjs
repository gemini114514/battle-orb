import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizePreset } from '../src/library.js';

const tempPath = 'C:/SillyTavern/vertex-master/temp.txt';
const presetPath = 'C:/Users/fengx/Downloads/Izumi 0503-RP用.json';
const outputPath = '.test/story-battle-declaration-live.json';
const temp = fs.readFileSync(tempPath, 'utf8');
const key = temp.match(/API Key\s*[=:：]\s*(\S+)/i)?.[1]?.trim();
if (!key) throw new Error('temp.txt 中没有 API Key');
const preset = normalizePreset(JSON.parse(fs.readFileSync(presetPath, 'utf8')), 'Izumi 0503-RP用.json');
const scenario = `
当前剧情已经明确进入数值回合制战斗：压力测试场是一片开阔地，艾莉丝独自持有等离子战矛与警用防爆盾，前方和周围散落着一百只本能行动、没有队形、主要依靠视觉和听觉搜寻的丧尸。战斗正式开始，必须将这场战斗交给本地战术演算终端，不要替本地引擎计算命中、伤害、死亡或胜负。
请先写一小段正文，再在正文末尾输出唯一一个 BattleDeclaration 隐藏 JSON 块。BattleDeclaration 必须严格包在 <BattleDeclaration> 与 </BattleDeclaration> 中，JSON 必须合法，至少包含 reason、battlefield(kind/shapeHint/description) 和 participants。为便于本地重放，participants 的 id 固定只能使用 player_alice 与 enemy_zombies，主角 source=existing、side=player、reference=主角、relativePosition=中心，丧尸 source=create、side=enemy、count=100、relativePosition=周边散落、distribution.style=scattered；每项都写 state，声明中不要出现 rows 或 columns。不要在块外输出 JSON，不要把坐标、HP、EP、攻击、防御、技能数值写进声明。
`;

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
const runs = [];
let validCount = 0;
try {
    for (let index = 1; index <= 6 && validCount < 3; index += 1) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        try {
            await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForFunction(() => window.__reincarnationApp?.runtime, null, { timeout: 60000 });
            const result = await page.evaluate(async ({ presetValue, keyValue, scenarioValue }) => {
                const app = window.__reincarnationApp;
                app.runtime.setPreset(presetValue);
                const existing = app.store.data.connections[0] || {};
                const connection = app.store.saveConnection({
                    ...existing,
                    name: 'temp.txt story battlefield live test',
                    protocol: 'openai-chat',
                    baseUrl: 'http://127.0.0.1:2156/v1',
                    path: '/chat/completions',
                    model: 'gemini-3-flash-preview',
                    apiKey: keyValue,
                    temperature: 0,
                    topP: 1,
                    maxTokens: 30000,
                    reasoningEffort: 'auto',
                    extraHeaders: '{}',
                    extraBody: '{"seed":424242}',
                });
                app.store.updateSettings({ aiAssignments: { ...(app.store.data.settings.aiAssignments || {}), storyConnectionId: connection.id } });
                const session = app.store.activeSession;
                const now = new Date().toISOString();
                session.messages = [
                    { id: 'battle-test-opening', role: 'assistant', content: '【开阔地遭遇】', createdAt: now, swipes: ['【开阔地遭遇】'], swipeIndex: 0 },
                    { id: 'battle-test-context', role: 'user', content: '艾莉丝观察到开阔地上的敌群，准备确认敌我位置。', createdAt: now, swipes: ['艾莉丝观察到开阔地上的敌群，准备确认敌我位置。'], swipeIndex: 0 },
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
                const trace = assistant?.promptTrace?.messages || [];
                return {
                    assistantId: assistant?.id || null,
                    responseChars: content.length,
                    responseHasDeclaration: Boolean(match),
                    declaration,
                    parseError,
                    validation,
                    promptMessageCount: trace.length,
                    systemHasBattleInstruction: trace.some(item => item.role === 'system' && /BattleDeclaration/.test(String(item.content || ''))),
                    promptRoles: trace.map(item => item.role),
                    response: content,
                };
            }, { presetValue: preset, keyValue: key, scenarioValue: scenario });
            runs.push({ index, ...result, pageErrors });
            if (result.responseHasDeclaration && result.validation?.ok === true && !pageErrors.length) validCount += 1;
        } catch (error) {
            runs.push({ index, error: error.message, pageErrors });
        } finally {
            await page.close();
        }
    }
} finally {
    await browser.close();
}

const normalize = declaration => declaration ? JSON.stringify({
    // Cosmetic prose, optional shape hints and create-side references are not
    // part of the stable hand-off contract.  The local modeler decides exact
    // coordinates and dimensions; the reproducibility check therefore locks
    // the participant identity/count/side/source and group distribution.
    participants: (declaration.participants || []).map(item => ({ id: item.id, count: item.count ?? 1, side: item.side, source: item.source, reference: item.source === 'existing' ? (item.reference || null) : null, relativePosition: Boolean(item.relativePosition), distributionStyle: item.distribution?.style || null })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
}) : null;
const signatures = runs.map(run => normalize(run.declaration));
const validRuns = runs.filter(run => run.responseHasDeclaration && run.validation?.ok === true && run.pageErrors.length === 0);
const stableThree = validRuns.length >= 3 && new Set(validRuns.slice(0, 3).map(run => normalize(run.declaration))).size === 1;
const report = {
    format: 'story-battle-declaration-live-test',
    generatedAt: new Date().toISOString(),
    source: { tempPath, presetPath, model: 'gemini-3-flash-preview', temperature: 0, topP: 1, maxTokens: 30000 },
    stableThree,
    validRunCount: validRuns.length,
    signatures,
    runs,
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ stableThree, signatures, runs: runs.map(run => ({ index: run.index, responseChars: run.responseChars, responseHasDeclaration: run.responseHasDeclaration, parseError: run.parseError, validationOk: run.validation?.ok ?? null, validationErrors: run.validation?.errors?.length ?? null, systemHasBattleInstruction: run.systemHasBattleInstruction, pageErrors: run.pageErrors, error: run.error || null })), outputPath }, null, 2));
if (!stableThree) process.exitCode = 1;
