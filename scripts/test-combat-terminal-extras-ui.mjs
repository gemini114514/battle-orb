import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reservePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(error => error ? reject(error) : resolve(port));
    });
});

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, REINCARNATION_PORT: String(port) },
});
const waitHealth = async () => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* startup race */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器未启动');
};

const qualities = { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' };
const declaration = {
    schema: 'vibe-combat-declaration/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true,
    contactPairs: [['hero', 'enemy']], reason: '终端扩展测试',
    battlefield: { kind: '走廊', shapeHint: 'rectangle', description: '已经互相看见的狭长走廊' },
    participants: [
        { id: 'hero', name: '主角', side: 'player', source: 'existing', reference: '主角', state: '持械警戒', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '中心' },
        { id: 'enemy', name: '测试敌人', side: 'enemy', source: 'create', state: '正面接触', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '前方' },
    ],
};
const modelResponse = JSON.stringify({ note: '故意无法通过本地校验的模型' });
const storyProse = '融合战报：主角在走廊尽头击溃了测试敌人，本地账本记录了全部骰点。';

let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requestBodies = [];
    let modelCalls = 0;
    let serviceErrorsServed = 0;
    await page.route('**/api/chat', async route => {
        modelCalls += 1;
        const body = JSON.parse(route.request().postData() || '{}');
        requestBodies.push(body);
        await new Promise(resolve => setTimeout(resolve, 60));
        if (modelCalls === 2 && serviceErrorsServed < 1) {
            // First modeling call times out upstream: the pipeline must retry
            // the same call instead of consuming a repair slot.
            serviceErrorsServed += 1;
            await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: 'upstream timeout (test)' } }) });
            return;
        }
        const isRecognition = body.messages?.some(message => String(message.content || '').includes('战场声明草拟器'));
        const content = isRecognition ? JSON.stringify(declaration) : modelResponse;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 } }),
        });
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const connection = { id: 'extras-test', name: 'Extras test', protocol: 'openai-chat', baseUrl: origin, path: '/api/chat', model: 'test-model', temperature: .7, maxTokens: 30000, apiKey: '' };
    await page.evaluate(async connectionValue => {
        const app = window.__reincarnationApp;
        app.store.data.connections = [connectionValue];
        app.store.data.settings.activeConnectionId = connectionValue.id;
        app.store.data.settings.aiAssignments = { storyConnectionId: connectionValue.id, combatConnectionId: connectionValue.id, shopConnectionId: connectionValue.id };
        app.store.save();
        await app.runtime.replaceVariables({ stat_data: { 主角: { 姓名: '主角', 层级: 'Ⅰ', HP: 20, HP_MAX: 20, EP: 0, EP_MAX: 0, 最终属性: { 五维品质: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' } } }, 世界: {}, 设置: {}, 系统状态: {}, 关系列表: {} } });
        app.renderAll();
    }, connection);

    // ---- 1) 额外需求输入框：随识别请求一起发送 ----
    await page.evaluate(() => document.querySelector('[data-panel="combat"]')?.click());
    await page.fill('#combatRecognitionNotes', '更大的战场规模，强调夜战');
    await page.locator('#combatDraftAiButton').click();
    await page.waitForFunction(() => document.querySelector('#combatDraftAiButton')?.getAttribute('data-recognition-state') === 'success', null, { timeout: 15000 });
    const recognitionBody = requestBodies[0];
    assert.ok(recognitionBody.messages.some(message => String(message.content || '').includes('playerRequirements') && String(message.content || '').includes('更大的战场规模')), '识别请求应包含玩家额外需求 playerRequirements');
    assert.equal(await page.locator('#textEditorDialog[open]').count(), 1, '识别成功后应打开 BattleDeclaration 确认编辑器');

    // ---- 2) 建模：服务超时不占修复名额；五次失败后出现“继续重试” ----
    await page.locator('[data-editor-action="save"]').click();
    await page.locator('#combatModelStatus.failed').waitFor({ state: 'visible', timeout: 60000 });
    const failedText = await page.locator('#combatModelStatus').textContent();
    assert.match(failedText, /五次/, '失败状态应说明五次尝试已耗尽');
    assert.equal(await page.locator('[data-action="combat-retry-modeling"]').count(), 1, '失败后应出现继续重试按钮');
    assert.equal(serviceErrorsServed, 1);
    // 1 recognition + 1 injected 502 + 5 invalid models = 7 calls; the 502
    // must not have consumed a repair slot.
    assert.equal(modelCalls, 7, `五次修复应恰好消耗五次模型调用（含一次被重试的服务错误），实际 ${modelCalls}`);

    await page.locator('[data-action="combat-retry-modeling"]').click();
    await page.waitForFunction(() => /第 6 次/.test(document.querySelector('#combatModelStatus')?.textContent || ''), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#combatModelStatus')?.classList.contains('failed'), null, { timeout: 60000 });
    assert.equal(modelCalls, 12, '继续重试应再进行五次建模调用');
    const resumedText = await page.locator('#combatModelStatus').textContent();
    assert.match(resumedText, /五次/, '追加重试轮结束后应再次进入失败状态');
    assert.equal(await page.locator('[data-combat-phase="model"].is-active').count(), 1, '失败状态应停留在第 2 步建模面板');

    // ---- 3) 战后处置输入框：随融合战报请求交给正文 AI ----
    const combatPayload = {
        storySessionId: null, mode: 'manual', seed: 'extras-disposition-seed',
        encounter: {
            title: '战后处置测试', battlefield: { shape: 'rectangle', widthMeters: 40, heightMeters: 20, center: { x: 0, y: 0 } },
            combatants: [
                { id: 'p', name: '主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, attack: 100, attackModifier: 100, defenseDC: 50, initiativeDC: 1000, visionMeters: 30, position: { x: .5, y: 0 } },
                { id: 'e', name: '敌人', side: 'enemy', controller: 'ai', hp: 10, maxHp: 10, attackModifier: -100, defenseDC: 50, initiativeDC: -100, visionMeters: 30, position: { x: 1.5, y: 0 } },
            ],
        },
    };
    const created = await (await fetch(`${origin}/api/combat/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(combatPayload) })).json();
    const started = await (await fetch(`${origin}/api/combat/${created.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'extras-start', expectedVersion: created.version, mode: 'manual' }) })).json();
    const struck = await (await fetch(`${origin}/api/combat/${created.id}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'extras-hit', expectedVersion: started.version, type: 'attack', actorId: 'p', abilityId: 'basic-attack', targetIds: ['e'] }) })).json();
    assert.equal(struck.status, 'completed', '近战一击应完成战斗以产生 CheckResult');
    await page.evaluate(async battleId => {
        const app = window.__reincarnationApp;
        app.store.activeSession.activeBattleId = battleId;
        app.store.save();
    }, created.id);
    await page.evaluate(() => document.querySelector('[data-panel="combat"]')?.click());
    await page.locator('[data-combat-phase="result"]').waitFor({ state: 'attached' });
    await page.locator('[data-action="combat-flow-phase"][data-combat-flow-step="result"]').click();
    await page.locator('[data-combat-phase="result"].is-active').waitFor({ state: 'visible' });
    await page.fill('#combatDispositionNotes', '搜刮战利品并逐件清点，什么都不要留下也要检查尸体');
    await page.locator('#combatNarrateButton').click();
    await page.waitForFunction(() => {
        const status = document.querySelector('#combatNarrateStatus');
        return status && /已写入|写入当前分支/.test(status.textContent || '');
    }, null, { timeout: 30000 });
    const narrationBody = requestBodies.at(-1);
    assert.ok(narrationBody.messages.some(message => String(message.content || '').includes('玩家战后处置要求') && String(message.content || '').includes('搜刮战利品')), '融合请求应包含玩家战后处置要求');
    const written = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const message = app.store.activeSession.messages.at(-1);
        return { combat: message?.combat || null, content: String(message?.content || '') };
    });
    assert.ok(written.combat?.battleId === created.id, '战报应写入剧情楼层');
    assert.ok(written.content.includes('<CheckResult>'), '战报楼层应附带本地 CheckResult');
    assert.equal(await page.inputValue('#combatDispositionNotes'), '', '写入成功后战后处置输入框应清空');

    // ---- 4) 世界书管理：预置条目 + 新建条目随世界书激活 ----
    await page.evaluate(() => document.querySelector('[data-panel="worldbook"]')?.click());
    await page.locator('#view-worldbook.active').waitFor({ state: 'visible' });
    await page.locator('#worldbookList .manager-item').first().waitFor({ state: 'visible' });
    const seedCount = await page.locator('#worldbookList .manager-item').count();
    assert.ok(seedCount >= 2, `应预置至少 2 条流程世界书条目，实际 ${seedCount}`);
    await page.locator('[data-action="worldbook-new"]').click();
    await page.fill('#worldbookForm [name="comment"]', '【测试】夜间照明条例');
    await page.fill('#worldbookForm [name="keys"]', '夜战, 照明弹');
    await page.fill('#worldbookForm [name="content"]', '夜间交战时未照明者承受命中劣势；照明弹会暴露投掷者位置。');
    await page.locator('#worldbookForm [type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#worldbookList .manager-item').length >= 3, null, { timeout: 10000 });
    const activation = await page.evaluate(() => {
        const runtime = window.__reincarnationRuntime;
        const hits = runtime.activeWorldbook([{ role: 'user', content: '他们在夜战中投出了照明弹' }]).map(entry => entry.comment);
        const seedHit = runtime.activeWorldbook([{ role: 'user', content: '战斗结束后玩家决定搜刮战利品' }]).map(entry => entry.comment);
        return { hits, seedHit, total: runtime.customWorldbook.length };
    });
    assert.ok(activation.hits.includes('【测试】夜间照明条例'), `新建条目应按关键词激活，实际命中：${activation.hits.join('、')}`);
    assert.ok(activation.seedHit.includes('【战后处置】搜刮与战利品规则'), `预置条目应按关键词激活，实际命中：${activation.seedHit.join('、')}`);
    assert.ok(activation.total >= 3, '运行时应挂载全部启用的自定义条目');

    // Custom entries must also flow into the real prompt build.
    const promptCheck = await page.evaluate(() => {
        const runtime = window.__reincarnationRuntime;
        const built = runtime.buildPrompt([{ role: 'user', content: '他们在夜战中投出了照明弹' }]);
        return built.messages.some(message => String(message.content || '').includes('照明弹会暴露投掷者位置'));
    });
    assert.ok(promptCheck, '自定义世界书条目应进入最终提示词');

    assert.deepEqual(errors, []);
    const screenshot = path.join(root, '.test', 'combat-terminal-extras-ui.png');
    fs.mkdirSync(path.join(root, '.test'), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(JSON.stringify({ ok: true, modelCalls, serviceErrorsServed, worldbookSeeds: seedCount, worldbookActive: activation.total, narrationBattleId: written.combat.battleId, screenshot, pageErrors: errors }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
