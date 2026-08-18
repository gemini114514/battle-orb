import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CARD_EQUIP_QUALITY_RANGES, CARD_LIFE_TIER_RANGES, CARD_PRICE_RANGES, CARD_SKILL_ITEM_RANGES, generateShopDraft, mergeApiCatalog, normalizeLifeLevel, shopModelPrompt, shopVisionQuality, tavernShopUserPrompt } from '../shop/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPort = 4186;
const mockPort = 4286;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(url) {
    for (let i = 0; i < 80; i += 1) {
        try { const response = await fetch(url); if (response.ok) return; } catch (_error) { /* starting */ }
        await wait(100);
    }
    throw new Error(`服务未在 ${url} 启动`);
}
function requestJson(server, port, pathname, body) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        });
        request.on('error', reject); request.end(JSON.stringify(body));
    });
}

const mockRequests = [];
const mock = http.createServer((request, response) => {
    let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => {
        const payload = JSON.parse(text); mockRequests.push(payload);
        response.setHeader('Content-Type', 'application/json');
        const tavernCompatible = payload.messages?.[0]?.content?.includes('主神兑换终端');
        const content = tavernCompatible
            ? `血统列表: []
形态列表:
  - 名称: 试作灵装
    层级: Ⅰ
    品质: F
    标签: [主神空间, 形态]
    原始属性: {力量: F, 敏捷: F, 体质: F, 精神: F, 魅力: F, ATK: F, DEF: F, MATK: F, MDEF: F, AP: F}
    描述: 由模型直接生成的形态商品
    价格: 88
技能列表: []
装备列表:
  - 名称: 酒馆基准短剑
    品质: F
    类型: 0
    标签: [主神空间, 武器]
    原始属性: {ATK: F}
    效果: {斩击: "造成(固定伤害+ATK)物理伤害"}
    描述: 由模型直接生成，不经过草案合并
    价格: 88
道具列表: []
升级列表: []`
            : JSON.stringify({ 刷新目标: { categories: ['equipment'], slotPreferences: ['武器'], qualityPreferences: ['SS'] }, 装备列表: [{ 名称: 'API 定向烈焰刃', 标签: ['API'], 描述: '由模型补全的文案', 价格: 1, 原始属性: { 命中: 999 } }] });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 } }));
    });
});
await new Promise(resolve => mock.listen(mockPort, '127.0.0.1', resolve));
const app = spawn(process.execPath, ['server.js', '--api-only'], { cwd: root, env: { ...process.env, REINCARNATION_PORT: String(appPort) }, stdio: 'ignore' });
try {
    await waitFor(`http://127.0.0.1:${appPort}/api/health`);
    const draft = generateShopDraft({ playerLevel: 6, slotPreferences: ['武器'], target: { categories: ['equipment'] }, seed: 'test-seed' });
    assert.equal(draft.baseQuality, 'A');
    assert.ok(draft.qualitySet.every(quality => ['A', 'S'].includes(quality)));
    assert.ok(draft.catalog.装备列表.length >= 3);
    const shieldDraft = generateShopDraft({ playerLevel: 3, slotPreferences: ['盾'], target: { categories: ['equipment'] }, seed: 'shield-type' });
    assert.ok(shieldDraft.catalog.装备列表.filter(item => item.标签?.includes('盾')).every(item => item.类型 === 0));
    const merged = mergeApiCatalog(draft.catalog, { 装备列表: [{ 名称: 'API', 价格: 1, 原始属性: { 命中: 999 } }] }, draft.target);
    assert.equal(merged.装备列表[0].名称, 'API');
    assert.equal(merged.装备列表[0].价格, 1);
    assert.equal(merged.装备列表[0].原始属性.命中, 999);
    const emptyMerge = mergeApiCatalog(draft.catalog, {}, draft.target);
    assert.equal(emptyMerge.装备列表.length, draft.catalog.装备列表.length);
    const flatMerge = mergeApiCatalog(draft.catalog, { 商品列表: [{ 名称: 'flat', 类型: '武器', 描述: '兼容卡片扁平商品列表', 价格: 1 }] }, draft.target);
    assert.equal(flatMerge.装备列表[0].名称, 'flat');
    assert.equal(flatMerge.装备列表[0].价格, 1);
    const skillDraft = generateShopDraft({ playerLevel: 3, target: { categories: ['skill'] }, seed: 'numeric-lock' });
    const originalConsume = skillDraft.catalog.技能列表[0].消耗;
    const modelValues = mergeApiCatalog(skillDraft.catalog, { 技能列表: [{ 名称: '文案', 消耗: 999, 伤害: '999d20', 价格: 1 }] }, skillDraft.target);
    assert.notEqual(modelValues.技能列表[0].消耗, originalConsume);
    assert.equal(modelValues.技能列表[0].消耗, 999);
    assert.equal(modelValues.技能列表[0].伤害, '999d20');
    assert.equal(modelValues.技能列表[0].价格, 1);

    const response = await requestJson(null, appPort, '/api/shop/refresh', {
        characterName: '测试轮回者', playerLifeLevel: 'Ⅲ', playerLevel: 3, seed: 'api-seed', slotPreferences: ['武器'], target: { categories: ['equipment'] },
        currentCatalog: { 技能列表: [{ id: 'old-skill', 名称: '保留技能', 等级: 1, 品质: 'F', 价格: 100 }] },
        connection: { baseUrl: `http://127.0.0.1:${mockPort}`, path: '/v1/chat/completions', protocol: 'openai-chat', model: 'mock', apiKey: 'secret', maxTokens: 1 },
        preset: { prompts: [{ role: 'system', content: '风格测试' }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.source, 'api');
    assert.equal(response.body.catalog.装备列表[0].名称, 'API 定向烈焰刃');
    assert.equal(response.body.catalog.装备列表[0].价格, 1);
    assert.equal(response.body.catalog.技能列表[0].名称, '保留技能');
    // The server does not silently repair legacy catalogues. This deliberately
    // remains the old value so the prompt/data source can be investigated.
    assert.equal(response.body.catalog.技能列表[0].价格, 100);
    assert.ok(response.body.apiTrace.prompt.includes('F 级价格只能是 10–99'));
    assert.ok(response.body.apiTrace.responseText.includes('API 定向烈焰刃'));
    assert.equal(response.body.apiTrace.response.装备列表[0].价格, 1);
    assert.ok(response.body.catalog.成员商库['测试轮回者']);
    assert.ok(mockRequests[0].max_tokens >= 30000);

    const tavern = await requestJson(null, appPort, '/api/shop/refresh', {
        characterName: '酒馆基准', playerLifeLevel: 'Ⅰ', target: { autonomous: true, categories: ['all'], query: '最便宜的D级装备' },
        hero: { 种族: '人类', 身份: ['穿越者'], 空间币: 1000, 血统: { 人类血统: { 品质: 'F', 原始属性: { 力量: 'F', 敏捷: 'F', 体质: 'F', 精神: 'F', 魅力: 'F' }, 效果: {} } } },
        tavernShopSystem: '你是「主神兑换终端」的商品生成子系统。\n\n<品质效果数值规则>\nF: 20-50\n</品质效果数值规则>',
        connection: { baseUrl: `http://127.0.0.1:${mockPort}`, path: '/v1/chat/completions', protocol: 'openai-chat', model: 'mock', apiKey: 'secret' },
    });
    assert.equal(tavern.status, 200);
    assert.equal(tavern.body.source, 'api');
    assert.equal(tavern.body.apiTrace.mode, 'tavern-v3.2.6-reference');
    assert.equal(tavern.body.apiTrace.messages.length, 2);
    assert.ok(tavern.body.apiTrace.system.includes('主神兑换终端'));
    assert.ok(tavern.body.apiTrace.prompt.includes('仅输出 YAML'));
    assert.ok(tavern.body.apiTrace.prompt.includes('层级: Ⅰ'));
    assert.equal(tavern.body.catalog.装备列表[0].名称, '酒馆基准短剑');
    assert.equal(tavern.body.catalog.装备列表[0].价格, 88);
    assert.equal(tavern.body.catalog.形态列表[0].名称, '试作灵装');
    assert.ok(tavern.body.catalog.成员商库['酒馆基准'].形态列表.length === 1);
    assert.ok(mockRequests.at(-1).messages[0].content.includes('主神兑换终端'));
    assert.match(tavernShopUserPrompt({ playerLevel: 'Ⅰ', characterName: '酒馆基准', hero: { 空间币: 1000 } }), /层级: Ⅰ/);

    const auto = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '模型决策', playerLifeLevel: 'Ⅲ', seed: 'auto-seed', target: { autonomous: true, categories: ['all'], query: '只要近战武器' }, connection: { baseUrl: `http://127.0.0.1:${mockPort}`, path: '/v1/chat/completions', protocol: 'openai-chat', model: 'mock', apiKey: 'secret' } });
    assert.equal(auto.status, 200);
    assert.equal(auto.body.source, 'api');
    assert.deepEqual(auto.body.target.categories, ['equipment']);
    assert.deepEqual(auto.body.target.qualityPreferences, ['SS']);
    assert.ok(auto.body.catalog.装备列表.length > 0);
    assert.ok(auto.body.catalog.装备列表.every(item => item.品质 === 'C'));
    assert.equal(auto.body.catalog.技能列表.length, 0);

    const slotsAlias = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '槽位别名', playerLifeLevel: 'Ⅲ', seed: 'slots-alias', target: { categories: ['equipment'], slots: ['盾'] } });
    assert.equal(slotsAlias.status, 200);
    assert.ok(slotsAlias.body.target.slots.includes('盾'));

    const local = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '本地', playerLevel: 1, seed: 'local-seed', target: { categories: ['skill'] } });
    assert.equal(local.status, 200);
    assert.equal(local.body.source, 'local');
    assert.ok(local.body.catalog.技能列表.length >= 2);
    assert.equal(local.body.qualityPolicy, 'tavern-shop-vision');
    assert.ok(local.body.catalog.技能列表.every(item => ['F', 'E'].includes(item.品质)));
    for (const item of local.body.catalog.技能列表) assert.ok(item.价格 >= CARD_PRICE_RANGES[item.品质][0] && (CARD_PRICE_RANGES[item.品质][1] === Infinity || item.价格 <= CARD_PRICE_RANGES[item.品质][1]));
    const invalidLevel = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '非法层级回退', playerLevel: 50, seed: 'invalid-level' });
    assert.equal(invalidLevel.status, 200);
    assert.equal(invalidLevel.body.playerLevel, 1);
    assert.equal(invalidLevel.body.playerLifeLevel, 'Ⅰ');

    // Life levels are exactly Ⅰ–Ⅸ.  The conversion below is intentionally
    // constrained to the original shop-vision rule, not general MVU data.
    assert.equal(normalizeLifeLevel('Ⅰ'), 1);
    assert.equal(normalizeLifeLevel('III'), 3);
    assert.equal(normalizeLifeLevel('9'), 9);
    assert.equal(normalizeLifeLevel('10'), 1);
    assert.equal(normalizeLifeLevel('50'), 1);
    assert.deepEqual(CARD_LIFE_TIER_RANGES, { 'Ⅰ': [1, 29], 'Ⅱ': [30, 99], 'Ⅲ': [100, 299], 'Ⅳ': [300, 999], 'Ⅴ': [1000, 2999], 'Ⅵ': [3000, 9999], 'Ⅶ': [10000, 29999], 'Ⅷ': [30000, 99999], 'Ⅸ': [100000, Infinity] });
    assert.equal(shopVisionQuality('Ⅰ'), 'F');
    assert.equal(shopVisionQuality('Ⅲ'), 'D');
    const levelOne = generateShopDraft({ playerLevel: 1, target: { categories: ['all'] }, seed: 'calibration-level-1' });
    assert.equal(levelOne.baseQuality, 'F');
    assert.ok(levelOne.catalog.装备列表.every(item => ['F', 'E'].includes(item.品质)));
    const levelThree = generateShopDraft({ playerLevel: 'Ⅲ', target: { categories: ['all'] }, seed: 'calibration-level-3' });
    assert.equal(levelThree.baseQuality, 'D');
    assert.ok(levelThree.catalog.装备列表.every(item => ['D', 'C'].includes(item.品质)));

    const sameSeedLow = generateShopDraft({ playerLevel: 1, target: { categories: ['equipment'] }, seed: 'shop-vision-seed' });
    const sameSeedHigh = generateShopDraft({ playerLevel: 9, target: { categories: ['equipment'] }, seed: 'shop-vision-seed' });
    assert.notDeepEqual(sameSeedLow.catalog.装备列表.map(item => [item.品质, item.价格]), sameSeedHigh.catalog.装备列表.map(item => [item.品质, item.价格]));
    const prompt = shopModelPrompt({ draft: sameSeedLow.generated, target: sameSeedLow.target, playerLevel: 3, characterName: '提示词测试' });
    assert.ok(prompt.includes('当前玩家层级为Ⅲ'));
    assert.ok(prompt.includes('商城视野'));
    assert.ok(prompt.includes('Ⅰ=F'));
    assert.ok(!prompt.includes('阿拉伯数字'));
    assert.ok(!prompt.includes('生命层级：Ⅲ（3）'));
    const skillPrompt = shopModelPrompt({ draft: generateShopDraft({ playerLevel: 1, target: { categories: ['skill'], qualityPreferences: ['F'] }, seed: 'prompt-numeric-visible' }).generated, target: { categories: ['skill'], qualityPreferences: ['F'] }, playerLevel: 1, characterName: '数值可追溯' });
    assert.match(skillPrompt, /"伤害":"\d+d\d+"/);
    assert.match(skillPrompt, /F\[10,99\]/);
    assert.match(skillPrompt, /F 级价格只能是 10–99/);

    assert.deepEqual(CARD_PRICE_RANGES, { F: [10, 99], E: [100, 999], D: [1000, 4999], C: [5000, 19999], B: [20000, 79999], A: [80000, 319999], S: [320000, 1270000], SS: [1280000, 5110000], SSS: [5120000, Infinity] });
    assert.deepEqual(CARD_SKILL_ITEM_RANGES.D, { 技能伤害: [100, 250], 检定修正: [13, 18], 道具HP: [150, 600], 状态预算: 2 });
    assert.deepEqual(CARD_EQUIP_QUALITY_RANGES.ATK.D, [25, 100]);
    const qualities = new Set(['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS']);
    const effectRecord = value => Object.values(value || {}).every(entry => typeof entry === 'string');
    for (let level = 1; level <= 9; level += 1) {
        const check = generateShopDraft({ playerLevel: level, target: { categories: ['all'] }, seed: `schema-${level}` });
        assert.equal(check.baseQuality, shopVisionQuality(level));
        const maximumQuality = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'][Math.min(level, 8)];
        const assertPrice = item => assert.ok(item.价格 >= CARD_PRICE_RANGES[item.品质][0] && (CARD_PRICE_RANGES[item.品质][1] === Infinity || item.价格 <= CARD_PRICE_RANGES[item.品质][1]), `${item.品质} price out of card band: ${item.价格}`);
        for (const item of check.catalog.血统列表) {
            assertPrice(item);
            assert.deepEqual(Object.keys(item.原始属性).sort(), ['力量', '敏捷', '体质', '精神', '魅力'].sort());
            assert.ok(Object.values(item.原始属性).every(value => qualities.has(value)));
            const mainCount = Object.values(item.原始属性).filter(value => value === item.品质).length;
            assert.ok(item.品质 === 'F' ? mainCount === 5 : mainCount <= 2 && mainCount >= 2);
            assert.ok(effectRecord(item.效果));
        }
        for (const item of check.catalog.技能列表) {
            assertPrice(item);
            assert.ok(Number.isInteger(item.类型) && item.类型 >= 0 && item.类型 <= 2);
            assert.equal(typeof item.消耗, 'string');
            assert.ok(effectRecord(item.效果));
        }
        for (const item of check.catalog.装备列表) {
            assertPrice(item);
            assert.ok(Number.isInteger(item.类型) && item.类型 >= 0 && item.类型 <= 8);
            assert.ok(Object.keys(item.原始属性).every(key => ['力量', '敏捷', '体质', '精神', '魅力', 'ATK', 'DEF', 'MATK', 'MDEF', 'AP'].includes(key)));
            assert.ok(Object.values(item.原始属性).every(value => qualities.has(value)));
            assert.ok(effectRecord(item.效果));
        }
        for (const item of check.catalog.道具列表) {
            assertPrice(item);
            assert.equal(typeof item.类型, 'string');
            assert.ok(Number.isInteger(item.数量) && item.数量 >= 0);
            assert.ok(effectRecord(item.效果));
        }
        for (const item of ['血统列表', '技能列表', '装备列表', '道具列表'].flatMap(key => check.catalog[key])) assert.ok(['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'].indexOf(item.品质) <= ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'].indexOf(maximumQuality), `${item.品质} exceeds ${maximumQuality} shop vision cap`);
    }
    const upgradeCheck = generateShopDraft({ playerLevel: 'Ⅲ', target: { categories: ['upgrade'] }, seed: 'schema-upgrade', hero: { 技能: { 旧技能: { 品质: 'F', 类型: 0, 消耗: '5', 效果: { 说明: '旧' } } }, 血统: { 旧血统: { 品质: 'F', 原始属性: { 力量: 'F', 敏捷: 'F', 体质: 'F', 精神: 'F', 魅力: 'F' } } }, 装备: { 旧武器: { 品质: 'F', 类型: 0, 原始属性: { ATK: 'F' } } } } });
    assert.equal(upgradeCheck.catalog.升级列表.length, 3);
    for (const item of upgradeCheck.catalog.升级列表) {
        assert.ok(item.价格 >= CARD_PRICE_RANGES[item.品质][0] && (CARD_PRICE_RANGES[item.品质][1] === Infinity || item.价格 <= CARD_PRICE_RANGES[item.品质][1]));
        assert.equal(item.品质, 'E');
        assert.ok(Number.isInteger(item.类型) && item.类型 >= 0 && item.类型 <= 8);
        assert.equal(typeof item.替换目标, 'string');
        assert.equal(typeof item.所属大类, 'string');
        assert.ok(effectRecord(item.效果));
    }

    const forge = await requestJson(null, appPort, '/api/shop/forge', { characterName: '脚本调用', args: { 生命层级: 'Ⅸ', 槽位偏好: ['武器'], 生成: '商店', NPC: [] } });
    assert.equal(forge.status, 200);
    assert.equal(forge.body.tool, 'forge_shop');
    assert.equal(forge.body.baseQuality, 'SSS');
    assert.equal(forge.body.playerLevel, 9);
    assert.ok(forge.body.catalog.装备列表.some(item => item.品质 === 'SSS'));
    assert.ok(forge.body.catalog.装备列表.length > 0);
    assert.ok(Array.isArray(forge.body.商品列表));
    assert.ok(forge.body.商品列表.length >= forge.body.catalog.装备列表.length);
    console.log('shop refresh tests passed');
} finally {
    app.kill();
    await new Promise(resolve => mock.close(resolve));
}
