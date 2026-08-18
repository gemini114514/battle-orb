import assert from 'node:assert/strict';
import fs from 'node:fs';

const sourcePath = '.test/last-save-combat-debug-final.json';
const baselinePath = '.test/last-save-100-zombies-result.json';
const kiting = process.argv.includes('--kiting');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const savedState = source.client.state;

// This is the exact 800-credit opening-catalogue item from V3.2.6.
// The combat model keeps the card grades/description as asset metadata and
// uses the lower bound of D-grade ATK (25) as the deterministic local attack
// panel for this regression run. No MVU field is mutated by this test.
const spear = {
    assetId: 'opening-e1_1-plasma-spear',
    fingerprint: 'equipment:等离子战矛:{"品质":"D","类型":1,"标签":["枪矛","重型","能量"],"原始属性":{"ATK":"D","MATK":"E"},"效果":{"穿透":"突刺附加能量灼烧"},"描述":"枪尖带有高热等离子场的战矛。","消耗":""}',
    kind: 'equipment',
    name: '等离子战矛',
    description: '枪尖带有高热等离子场的战矛。',
    attributes: { ATK: 'D', MATK: 'E' },
    effects: { 穿透: '突刺附加能量灼烧' },
    consume: '',
    tags: ['枪矛', '重型', '能量'],
    combat: { minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, attackStyle: '近战突刺 · 等离子灼烧' },
};

const hero = structuredClone(savedState.combatants[0]);
hero.id = 'last-save-hero-repro';
hero.controller = 'ai';
hero.attack = 25;
hero.magicAttack = 10;
hero.assetBindings = [spear.assetId];
hero.equipment = [spear.assetId];
hero.abilities = [{ id: 'basic-attack', name: kiting ? '等离子战矛·拉扯突刺' : '等离子战矛·突刺', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: kiting ? 3.5 : 1.5, cooldownRounds: 0, targetCount: 1, aoe: false, script: null }];

const zombie = structuredClone(savedState.combatants.find(unit => unit.side === 'enemy'));
zombie.id = 'last-save-zombie-repro';
zombie.name = '本能丧尸';
zombie.count = 100;
zombie.position = { x: hero.position.x + Math.max(8, Math.min(18, Number(hero.visionMeters || 30) * .55)), y: hero.position.y };
zombie.tacticalProfile = { archetype: 'scattered', groupId: 'last-save-zombies-repro', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 };

const encounter = {
    title: `最后存档人物 · 等离子战矛 · ${kiting ? '拉扯' : '站桩'} · 1 对 100 丧尸复测`,
    location: savedState.location || '标准二维测试场',
    description: `在最后存档人物基础上绑定开局 800 空间币等离子战矛，验证装备资产、武器攻击面板、伤害结算与 8 接触位规则。${kiting ? '追加保持距离、命中后自动后撤的本地拉扯策略。' : ''}`,
    battlefield: savedState.battlefield,
    combatants: [hero, zombie],
    assetProfiles: [spear],
};

const origin = process.env.REINCARNATION_ORIGIN || 'http://127.0.0.1:4174';
const request = async (path, options) => {
    const response = await fetch(`${origin}/api/combat${path}`, options);
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
    return body;
};

const created = await request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transient: true, simulation: { source: 'combat-simulator', scenarioId: kiting ? 'last-save-same-tier-horde-spear-kiting' : 'last-save-same-tier-horde-spear' }, seed: 'last-save-100-zombies-regression-v1', mode: 'auto', encounter }) });
const configured = kiting ? await request(`/${created.id}/strategy/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '采用拉扯战术：保持距离，边打边退，避免同时与所有敌人交战。', confirmed: true, takeoverTriggers: [{ field: 'round', operator: '>=', value: 9999 }] }) }) : created;
await request(`/${created.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'last-save-100-zombies-spear-start', expectedVersion: configured.version, mode: 'auto' }) });
const state = await request(`/${created.id}`);
const replay = await request(`/${created.id}/replay`);
const checks = replay.events.filter(event => event.type === 'attack_check').map(event => event.payload);
const hits = checks.filter(check => check.outcome === 'hit' || check.outcome === 'miracle');
const mismatches = hits.map(check => ({
    targetId: check.targetId,
    beforeHp: Number(check.applied?.before?.hp || 0),
    afterHp: Number(check.applied?.after?.hp || 0),
    reportedHpDamage: Number(check.applied?.hpDamage || 0),
})).map(item => ({ ...item, actualHpDamage: item.beforeHp - item.afterHp })).filter(item => item.reportedHpDamage !== item.actualHpDamage);
const spearAttackChecks = checks.filter(check => check.actorId === hero.id);
const spearHits = spearAttackChecks.filter(check => check.outcome === 'hit' || check.outcome === 'miracle');
const report = {
    format: 'reincarnation-last-save-100-zombies-spear-test',
    generatedAt: new Date().toISOString(),
    sourcePath,
    baselinePath,
    battleId: created.id,
    input: {
        sourceItem: { id: 'e1_1', name: '等离子战矛', tier: 'D', cost: 800, type: 1, attrs: { ATK: 'D', MATK: 'E' }, effects: { 穿透: '突刺附加能量灼烧' } },
        deterministicCombatMapping: { attack: 25, magicAttack: 10, note: '采用 D 级 ATK 下界 25；卡片文案属性与本地数值面板分开保存', strategy: kiting ? '拉扯/风筝：命中后使用剩余移动预算沿远离最近敌人的方向后撤' : '站桩自动演算' },
        hero: { id: hero.id, name: hero.name, hp: hero.hp, maxHp: hero.maxHp, ep: hero.ep, maxEp: hero.maxEp, attack: hero.attack, magicAttack: hero.magicAttack, attackModifier: hero.attackModifier, defenseDC: hero.defenseDC, armor: hero.armor, resistance: hero.resistance, visionMeters: hero.visionMeters, assetBindings: hero.assetBindings, abilities: hero.abilities },
        enemyCount: 100,
        enemyHp: zombie.hp,
        enemyAttack: zombie.attack,
        enemyAttackModifier: zombie.attackModifier,
        battlefield: encounter.battlefield,
    },
    comparison: {
        unarmedDamageTotal: baseline.result.damageTotal,
        unarmedHpDamageTotal: baseline.result.hpDamageTotal,
        unarmedHeroKills: baseline.result.player?.[0]?.kills ?? 0,
    },
    result: {
        status: state.status,
        pauseReason: state.pauseReason,
        round: state.round,
        eventCount: replay.events.length,
        attackChecks: checks.length,
        hits: hits.length,
        spearAttackChecks: spearAttackChecks.length,
        spearHits: spearHits.length,
        damageTotal: hits.reduce((sum, check) => sum + Number(check.damage?.final || 0), 0),
        hpDamageTotal: hits.reduce((sum, check) => sum + Number(check.applied?.hpDamage || 0), 0),
        miracleCount: hits.filter(check => check.outcome === 'miracle').length,
        player: state.combatants.filter(unit => unit.side === 'player').map(unit => ({ id: unit.id, hp: unit.hp, thp: unit.thp, state: unit.state, kills: unit.kills })),
        enemyStates: state.combatants.filter(unit => unit.side === 'enemy').reduce((counts, unit) => ({ ...counts, [unit.state]: (counts[unit.state] || 0) + 1 }), {}),
        retreatEvents: replay.events.filter(event => event.type === 'strategy_retreat').length,
        enemyAttackChecks: checks.filter(check => check.actorId !== hero.id).length,
        contactProfile: replay.events.filter(event => event.type === 'melee_slots_allocated' && event.payload?.targetId === hero.id).map(event => ({ round: event.round, attackers: event.payload?.attackerIds?.length || 0, waiting: event.payload?.waitingCount || 0 })),
        strategy: state.strategy,
        maxContactAttackers: Math.max(0, ...replay.events.filter(event => event.type === 'melee_slots_allocated' && event.payload?.targetId === hero.id).map(event => event.payload?.attackerIds?.length || 0)),
        settlement: { winner: state.finalResult?.winner, casualtyCount: state.finalResult?.casualties?.length || 0, checkResultCount: state.finalResult?.checkResults?.length || 0, resultHash: state.finalResult?.eventHash, eventHash: state.eventHash, hashAligned: state.finalResult?.eventHash === state.eventHash },
        mismatches,
    },
    replay,
};

assert.equal(report.input.enemyCount, 100);
assert.equal(state.assetProfiles?.[0]?.name, '等离子战矛');
assert.ok(report.result.spearAttackChecks > 0, '等离子战矛没有产生玩家攻击检定');
assert.ok(report.result.spearHits > 0, '等离子战矛没有产生玩家命中');
assert.equal(report.result.status, 'completed');
assert.equal(report.result.mismatches.length, 0, '结算 HP 损失与事件记录不一致');
assert.equal(report.result.settlement.checkResultCount, report.result.attackChecks);
assert.equal(report.result.settlement.hashAligned, true);
if (kiting) {
    assert.ok(report.result.retreatEvents > 0, '拉扯策略没有产生后撤动作');
    assert.ok(report.result.maxContactAttackers <= 8, '拉扯策略突破了单目标八接触位上限');
}
const outputPath = kiting ? '.test/last-save-100-zombies-kiting-result.json' : '.test/last-save-100-zombies-spear-result.json';
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, outputPath, battleId: report.battleId, result: report.result, comparison: report.comparison }, null, 2));
