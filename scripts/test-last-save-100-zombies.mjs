import assert from 'node:assert/strict';
import fs from 'node:fs';

const sourcePath = '.test/last-save-combat-debug-final.json';
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const savedState = source.client.state;
const hero = structuredClone(savedState.combatants[0]);
hero.id = 'last-save-hero-repro';
hero.controller = 'ai';
const zombie = structuredClone(savedState.combatants.find(unit => unit.side === 'enemy'));
zombie.id = 'last-save-zombie-repro';
zombie.name = '本能丧尸';
zombie.count = 100;
zombie.position = { x: hero.position.x + Math.max(8, Math.min(18, Number(hero.visionMeters || 30) * .55)), y: hero.position.y };
zombie.tacticalProfile = { archetype: 'scattered', groupId: 'last-save-zombies-repro', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 };
const encounter = {
    title: '最后存档人物 · 1 对 100 丧尸复测',
    location: savedState.location || '标准二维测试场',
    description: '从最后黑盒存档复制主角战斗数据，重新放置在感知范围边缘，验证接敌、伤害、近战槽位与终局结算。',
    battlefield: savedState.battlefield,
    combatants: [hero, zombie],
};

const origin = process.env.REINCARNATION_ORIGIN || 'http://127.0.0.1:4174';
const request = async (path, options) => {
    const response = await fetch(`${origin}/api/combat${path}`, options);
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
    return body;
};
const created = await request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transient: true, simulation: { source: 'combat-simulator', scenarioId: 'last-save-same-tier-horde' }, seed: 'last-save-100-zombies-regression-v1', mode: 'auto', encounter }) });
await request(`/${created.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'last-save-100-zombies-start', expectedVersion: created.version, mode: 'auto' }) });
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
const report = {
    format: 'reincarnation-last-save-100-zombies-test',
    generatedAt: new Date().toISOString(),
    sourcePath,
    battleId: created.id,
    input: { hero: { id: hero.id, name: hero.name, hp: hero.hp, maxHp: hero.maxHp, ep: hero.ep, maxEp: hero.maxEp, attack: hero.attack, magicAttack: hero.magicAttack, attackModifier: hero.attackModifier, defenseDC: hero.defenseDC, armor: hero.armor, resistance: hero.resistance, visionMeters: hero.visionMeters, abilities: hero.abilities }, enemyCount: 100, enemyHp: zombie.hp, enemyAttack: zombie.attack, enemyAttackModifier: zombie.attackModifier, battlefield: encounter.battlefield },
    result: { status: state.status, pauseReason: state.pauseReason, round: state.round, eventCount: replay.events.length, attackChecks: checks.length, hits: hits.length, damageTotal: hits.reduce((sum, check) => sum + Number(check.damage?.final || 0), 0), hpDamageTotal: hits.reduce((sum, check) => sum + Number(check.applied?.hpDamage || 0), 0), miracleCount: hits.filter(check => check.outcome === 'miracle').length, player: state.combatants.filter(unit => unit.side === 'player').map(unit => ({ id: unit.id, hp: unit.hp, thp: unit.thp, state: unit.state, kills: unit.kills })), enemyStates: state.combatants.filter(unit => unit.side === 'enemy').reduce((counts, unit) => ({ ...counts, [unit.state]: (counts[unit.state] || 0) + 1 }), {}), settlement: { winner: state.finalResult?.winner, casualtyCount: state.finalResult?.casualties?.length || 0, checkResultCount: state.finalResult?.checkResults?.length || 0, resultHash: state.finalResult?.eventHash, eventHash: state.eventHash, hashAligned: state.finalResult?.eventHash === state.eventHash }, mismatches },
    replay,
};
assert.equal(report.input.enemyCount, 100);
assert.ok(report.result.attackChecks > 0, '1v100 复测没有任何攻击检定');
assert.ok(report.result.hits > 0, '1v100 复测没有任何命中');
assert.equal(report.result.status, 'completed');
assert.equal(report.result.settlement.winner, 'enemy');
assert.equal(report.result.mismatches.length, 0, '结算 HP 损失与事件记录不一致');
assert.equal(report.result.settlement.checkResultCount, report.result.attackChecks);
assert.equal(report.result.settlement.hashAligned, true);
const outputPath = '.test/last-save-100-zombies-result.json';
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, outputPath, battleId: report.battleId, result: report.result }, null, 2));
