import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCombatRouter } from '../combat/router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const formal = JSON.parse(fs.readFileSync(path.join(project, '.test', 'last-save-100-zombies-formal-client-result.json'), 'utf8'));
const root = path.join(project, '.test', 'guerrilla-v2-regression-api');
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
const combat = createCombatRouter(root); const app = express(); app.use(express.json({ limit: '20mb' })); app.use('/api/combat', combat.router);
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/combat`;
const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, { headers: { 'content-type': 'application/json' }, ...options });
    const data = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${data.error}`); return data;
};

function encounter() {
    return {
        title: '正式MVU · 游击回归 · 1V100散乱丧尸', location: '开阔二维测试场',
        battlefield: { shape: 'rectangle', widthMeters: 240, heightMeters: 120, center: { x: 0, y: 0 } },
        combatants: [
            {
                id: 'formal-hero', name: '艾莉丝', side: 'player', controller: 'player', position: { x: 55, y: 0 }, facingDegrees: 180, fovDegrees: 120, baseSpeedMeters: 6, visionMeters: 30,
                mvu: { player: formal.formalPlayer, selectedWeaponName: '等离子战矛' },
                intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 20, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 4, attackNoiseMeters: 18 },
                tacticalProfile: { archetype: 'scattered', groupId: 'formal-hero', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 0 },
                abilities: [{ id: 'basic-attack', name: '等离子战矛·突刺', type: 'hybrid', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }],
            },
            {
                id: 'scattered-zombie', name: '本能丧尸', side: 'enemy', controller: 'ai', count: 100, position: { x: 25, y: 0 }, distribution: { style: 'scattered', radiusMeters: 20, spacingMeters: 1.25, jitterMeters: 1.2 },
                hp: 56, maxHp: 56, ep: 0, maxEp: 0, attack: 9, magicAttack: 2, attackModifier: 5, defenseDC: 50, initiativeDC: 0, armor: 0, resistance: 0,
                radiusMeters: .5, baseSpeedMeters: 6, facingDegrees: 180, fovDegrees: 120, visionMeters: 30,
                attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 },
                intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 20, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 8, attackNoiseMeters: 18 },
                tacticalProfile: { archetype: 'scattered', groupId: 'zombie-pack', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 },
            },
        ],
    };
}

const trialCount = Math.max(1, Math.min(20, Number(process.env.GUERRILLA_TRIALS || 20)));
const trials = [];
for (let index = 0; index < trialCount; index += 1) {
    const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ transient: false, mode: 'auto', seed: `formal-guerrilla-v2-${index + 1}`, encounter: encounter() }) });
    const configured = await request(`/${created.id}/strategy/compile`, { method: 'POST', body: JSON.stringify({ commandId: `strategy-${index}`, expectedVersion: created.version, mode: 'auto', text: '潜行游击，分割敌群，逐个击破，保持距离，避免主群。', confirmed: true }) });
    await request(`/${created.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: `start-${index}`, expectedVersion: configured.version, mode: 'auto' }) });
    const state = await request(`/${created.id}`); const replay = await request(`/${created.id}/replay`);
    const hero = state.combatants.find(unit => unit.id === 'formal-hero');
    const initialHero = state.initialSnapshot?.combatants?.find(unit => unit.id === 'formal-hero') || hero;
    const checks = replay.events.filter(event => event.type === 'attack_check');
    const enemyAwarePeak = replay.events.filter(event => event.type === 'activation_summary').reduce((peak, event) => Math.max(peak, Number(event.payload?.enemyAwareOfPlayer || 0)), 0);
    const postureEvents = replay.events.filter(event => event.type === 'guerrilla_posture_changed' && event.payload?.actorId === hero.id);
    const escapeEvents = replay.events.filter(event => event.type === 'guerrilla_escape_assessed' && event.payload?.actorId === hero.id);
    const zeroDistanceMoves = replay.events.filter(event => event.type === 'unit_moved' && event.payload?.actorId === hero.id && Number(event.payload?.distanceMeters || 0) <= 1e-6);
    const heroChecks = checks.filter(event => event.payload.actorId === hero.id);
    trials.push({ seed: index + 1, status: state.status, pauseReason: state.pauseReason || null, winner: state.finalResult?.winner || null, round: state.round, hero: { hp: hero.hp, maxHp: hero.maxHp, ep: hero.ep, maxEp: hero.maxEp, state: hero.state, kills: hero.kills, attack: hero.attack, magicAttack: hero.magicAttack, attackModifier: hero.attackModifier, armor: hero.armor, resistance: hero.resistance, attributes: hero.attributes, provenance: hero.combatProvenance, formalPanel: { hp: initialHero.hp, maxHp: initialHero.maxHp, ep: initialHero.ep, maxEp: initialHero.maxEp, attack: initialHero.attack, magicAttack: initialHero.magicAttack, attackModifier: initialHero.attackModifier, armor: initialHero.armor, resistance: initialHero.resistance, attributes: initialHero.attributes } }, remaining: state.combatants.filter(unit => unit.side === 'enemy' && unit.state === 'active').length, hits: heroChecks.filter(event => ['hit', 'miracle'].includes(event.payload.outcome)).length, ambushes: heroChecks.filter(event => event.payload.ambush).length, enemyAwarePeak, maxContact: Math.max(0, ...replay.events.filter(event => event.type === 'melee_slots_allocated' && event.payload?.targetId === hero.id).map(event => event.payload.attackerIds?.length || 0)), guerrillaPostureTransitions: postureEvents.length, guerrillaEscapeAssessments: escapeEvents.length, zeroDistanceMoves: zeroDistanceMoves.length, eventHashAligned: state.finalResult?.eventHash === state.eventHash });
}
const wins = trials.filter(trial => trial.winner === 'player');
const losses = trials.filter(trial => trial.winner === 'enemy');
const winLosses = wins.map(trial => 1 - trial.hero.hp / trial.hero.maxHp).sort((a, b) => a - b);
const report = { format: 'reincarnation-guerrilla-v2-formal-regression', generatedAt: new Date().toISOString(), formalPanel: formal.formalPlayer, trials, summary: { wins: wins.length, losses: losses.length, paused: trials.filter(trial => trial.status === 'paused').length, takeoverPauses: trials.filter(trial => trial.pauseReason?.type === 'takeover_trigger').length, dyingPauses: trials.filter(trial => trial.pauseReason?.type === 'player_dying').length, safetyLimitPauses: trials.filter(trial => trial.pauseReason?.type === 'safety_limit').length, roundLimitPauses: trials.filter(trial => trial.pauseReason?.type === 'round_limit').length, winRate: wins.length / trials.length, medianWinHpLoss: winLosses.length ? winLosses[Math.floor(winLosses.length / 2)] : null, maxContact: Math.max(...trials.map(trial => trial.maxContact)), maxEnemyAware: Math.max(...trials.map(trial => trial.enemyAwarePeak)) } };
fs.writeFileSync(path.join(project, '.test', 'guerrilla-v2-formal-result.json'), JSON.stringify(report, null, 2));
const sample = trials[0]?.hero;
assert.deepEqual(sample.formalPanel.attributes, { strengthModifier: 4, dexterityModifier: 4, constitutionModifier: 4, spiritModifier: 1, charismaModifier: 1 });
assert.equal(sample.formalPanel.hp, 56); assert.equal(sample.formalPanel.maxHp, 56); assert.equal(sample.formalPanel.ep, 8); assert.equal(sample.formalPanel.maxEp, 8);
assert.equal(sample.formalPanel.attack, 54); assert.equal(sample.formalPanel.magicAttack, 40); assert.equal(sample.formalPanel.attackModifier, 4, 'D100 攻击修正必须直接读取 MVU 力量修正，禁止乘 5'); assert.equal(sample.formalPanel.armor, 14); assert.equal(sample.formalPanel.resistance, 10);
assert.ok(trials.every(trial => trial.maxContact <= 8));
assert.ok(trials.every(trial => trial.guerrillaPostureTransitions > 0 && trial.guerrillaEscapeAssessments > 0), '游击策略必须实际经过突袭后的脱离状态机');
assert.ok(trials.every(trial => trial.ambushes > 0), '潜行游击必须至少实际触发一次 D100 伏击优势');
assert.ok(trials.every(trial => trial.zeroDistanceMoves === 0), '零距离重算不得产生移动事件或声源');
assert.ok(trials.filter(trial => trial.status === 'completed').every(trial => trial.eventHashAligned));
console.log(JSON.stringify({ ok: true, output: '.test/guerrilla-v2-formal-result.json', summary: report.summary }, null, 2));
await new Promise(resolve => server.close(resolve));
