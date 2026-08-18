import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCombatRouter } from '../combat/router.js';

// Full-endurance regression: formal MVU/CardRuntime numbers are read from the
// freshly generated formal report, while every turn still goes through the
// public combat router. The policy is deliberately guerrilla: stealth search,
// isolate one confirmed target, strike twice if needed, retreat, re-hide.
const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const sourcePath = path.join(project, '.test', 'last-save-combat-debug-final.json');
const formalPath = path.join(project, '.test', 'last-save-100-zombies-formal-client-result.json');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const formal = JSON.parse(fs.readFileSync(formalPath, 'utf8'));
const savedState = source.client.state;
const savedHero = savedState.combatants.find(unit => unit.side === 'player');
const savedEnemies = savedState.combatants.filter(unit => unit.side === 'enemy');
const formalWeapon = formal.formalWeaponPanel;
const formalPlayer = formal.formalPlayer;
assert.equal(savedEnemies.length, 100, '最后存档必须包含 100 个丧尸');
assert.ok(Number(formalWeapon?.ATK) + Number(formalWeapon?.MATK) >= 85, '正式客户端武器 ATK+MATK 未达到预期面板');

const root = path.join(project, '.test', 'last-save-100-zombies-guerrilla-full-api');
fs.mkdirSync(root, { recursive: true });
const db = path.join(root, 'data', 'combat.sqlite');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${db}${suffix}`)) fs.rmSync(`${db}${suffix}`);
const combat = createCombatRouter(root);
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/combat', combat.router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/combat`;
const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error(`${response.status}: ${raw.slice(0, 300)}`); }
    if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
    return body;
};

const player = structuredClone(savedHero);
player.id = 'last-save-guerrilla-hero';
player.name = `${formalPlayer?.姓名 || savedHero.name || '艾莉丝'} · 全歼游击复测`;
player.controller = 'player';
player.hp = Number(formalPlayer?.HP ?? savedHero.hp);
player.maxHp = Number(formalPlayer?.HP_MAX ?? savedHero.maxHp);
player.ep = Number(formalPlayer?.EP ?? savedHero.ep);
player.maxEp = Number(formalPlayer?.EP_MAX ?? savedHero.maxEp);
player.attack = Number(formalWeapon.ATK);
player.magicAttack = Number(formalWeapon.MATK);
player.attackModifier = Number(formal.formalPlayer?.最终属性?.攻击修正 ?? savedHero.attackModifier ?? 5);
player.defenseDC = Number(formal.formalPlayer?.最终属性?.防御DC ?? savedHero.defenseDC ?? 50);
player.initiativeDC = 1000;
player.position = { x: -22, y: -3.3 };
player.intelProfile = { presence: 'concealed', stealthBonus: 20, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 18 };
player.tacticalProfile = { archetype: 'scattered', groupId: 'last-save-guerrilla-hero', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 };
player.abilities = [{ id: 'basic-attack', name: '等离子战矛·突刺', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false, weakPoint: false, script: null }];

const enemies = savedEnemies.map((sourceEnemy, index) => {
    const enemy = structuredClone(sourceEnemy);
    enemy.id = `last-save-guerrilla-zombie-${String(index + 1).padStart(3, '0')}`;
    enemy.controller = 'ai';
    enemy.initiativeDC = -100;
    enemy.visionMeters = 20;
    enemy.intelProfile = { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 4, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 };
    enemy.tacticalProfile = { archetype: 'scattered', groupId: 'last-save-guerrilla-scattered-zombies', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 };
    return enemy;
});

const encounter = {
    title: '最后存档人物 · 正式 ATK/MATK · 游击分割全歼尝试 · 1 对 100 丧尸',
    location: savedState.location || '压力测试场 · 开阔地',
    description: '不修改正式客户端生成的主角面板；以潜行、分割、单点突袭、脱离和再潜行为主，持续尝试歼灭全部丧尸。',
    battlefield: structuredClone(savedState.battlefield),
    combatants: [player, ...enemies],
};

const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ transient: true, simulation: { source: 'last-save-formal-client', scenarioId: 'guerrilla-full-elimination-100-zombies' }, seed: 'last-save-guerrilla-full-v1', mode: 'manual', encounter }) });
let state = await request(`/${created.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'guerrilla-full-start', expectedVersion: created.version }) });
state = await request(`/${created.id}/strategy/compile`, { method: 'POST', body: JSON.stringify({ commandId: 'guerrilla-full-strategy', expectedVersion: state.version, text: '游击队战术：潜行侦察，分割目标，逐个击破；每次突袭后立刻脱离并重新潜行，避免主群交战，直到歼灭全部丧尸。', confirmed: true, mode: 'manual' }) });
assert.equal(state.strategy.guerrilla, true);

const actions = [];
let pendingRetreat = false;
let resneakPending = false;
let lastTargetId = null;
let commandIndex = 0;
const issue = async (type, data = {}) => {
    const commandId = `guerrilla-full-${++commandIndex}-${type}`;
    const body = await request(`/${created.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId, expectedVersion: state.version, actorId: player.id, type, ...data }) });
    state = body;
    actions.push({ commandId, type, round: body.round, status: body.status, activeUnitId: body.activeUnitId, player: body.combatants.find(unit => unit.id === player.id)?.position, playerHp: body.combatants.find(unit => unit.id === player.id)?.hp, targetId: data.targetIds?.[0] || null });
    return body;
};
const distance = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
const edgeDistance = (a, b) => distance(a, b) - Number(a.radiusMeters || .5) - Number(b.radiusMeters || .5);
const living = unit => unit?.state === 'active' && Number(unit.hp) > 0;
const knownTargets = view => view.combatants.filter(unit => unit.side === 'enemy' && living(unit) && view.intel.knowledge[unit.id]?.[player.id]?.canTarget).sort((a, b) => edgeDistance(view.combatants.find(item => item.id === player.id), a) - edgeDistance(view.combatants.find(item => item.id === player.id), b));
const nearestActive = view => view.combatants.filter(unit => unit.side === 'enemy' && living(unit)).sort((a, b) => distance(view.combatants.find(item => item.id === player.id), a) - distance(view.combatants.find(item => item.id === player.id), b))[0];
const canUseContact = (view, target) => view.meleeSlots?.targets?.[target.id]?.attackerIds?.includes(player.id) || !view.meleeSlots?.targets?.[target.id];

// 600 player decisions is intentionally finite and much larger than the
// expected 200 two-hit kills. A terminal state always ends the loop earlier.
for (let decision = 0; decision < 600; decision += 1) {
    const view = await request(`/${created.id}`);
    state = view;
    const hero = view.combatants.find(unit => unit.id === player.id);
    const remaining = view.combatants.filter(unit => unit.side === 'enemy' && living(unit)).length;
    if (['completed', 'abandoned'].includes(view.status)) break;
    if (!living(hero)) {
        // Manual mode deliberately pauses on a dying player. Switch only the
        // already-terminal protagonist to auto so the normal engine can close
        // the battle and write the enemy-win result instead of leaving a half
        // finished test row.
        if (view.status === 'paused' && view.pauseReason?.type === 'player_dying') {
            state = await request(`/${created.id}/control`, { method: 'POST', body: JSON.stringify({ commandId: `guerrilla-full-settle-${decision}`, expectedVersion: view.version, mode: 'auto' }) });
            state = await request(`/${created.id}/advance`, { method: 'POST', body: JSON.stringify({ commandId: `guerrilla-full-settle-advance-${decision}`, expectedVersion: state.version, mode: 'auto', maxActions: 10000 }) });
        }
        break;
    }
    if (view.activeUnitId !== player.id) {
        // The only expected non-player pause is a transient reaction window;
        // let the generic advance endpoint resolve it before continuing.
        if (view.status === 'paused') state = await request(`/${created.id}/advance`, { method: 'POST', body: JSON.stringify({ commandId: `guerrilla-full-advance-${decision}`, expectedVersion: view.version, maxActions: 1000 }) });
        continue;
    }
    const known = knownTargets(view);
    const target = known[0] || null;

    if (pendingRetreat) {
        const retreatTarget = view.combatants.find(unit => unit.id === lastTargetId && living(unit)) || target || nearestActive(view);
        if (retreatTarget && view.turnBudget?.[player.id]?.movement > 0) {
            const dx = hero.position.x - retreatTarget.position.x;
            const dy = hero.position.y - retreatTarget.position.y;
            const length = Math.hypot(dx, dy) || 1;
            const travel = Math.min(Number(hero.speedMeters || 6), 6);
            await issue('move', { x: hero.position.x + dx / length * travel, y: hero.position.y + dy / length * travel });
        }
        pendingRetreat = false;
        resneakPending = true;
        const afterRetreat = state.status === 'paused' && state.activeUnitId === player.id ? await request(`/${created.id}`) : null;
        if (afterRetreat?.turnBudget?.[player.id]?.movement > 0) await issue('sneak');
        if (state.status === 'paused' && state.activeUnitId === player.id) await issue('wait');
        continue;
    }

    if (resneakPending) {
        resneakPending = false;
        if (view.turnBudget?.[player.id]?.movement > 0 && !hero.statuses?.some(status => status.id === 'stealth')) await issue('sneak');
        if (state.status === 'paused' && state.activeUnitId === player.id) await issue('wait');
        continue;
    }

    const stealthed = hero.statuses?.some(status => status.id === 'stealth');
    if (!stealthed && !target) {
        await issue('sneak');
        if (state.status === 'paused' && state.activeUnitId === player.id) await issue('wait');
        continue;
    }
    if (!target) {
        // Search toward the nearest living unit without making it a legal
        // target until the intelligence subsystem confirms it.
        const destination = nearestActive(view);
        if (!destination) break;
        const dx = destination.position.x - hero.position.x;
        const dy = destination.position.y - hero.position.y;
        const length = Math.hypot(dx, dy) || 1;
        const travel = Math.min(Number(hero.speedMeters || 6), length);
        if (view.turnBudget?.[player.id]?.movement > 0) await issue('move', { x: hero.position.x + dx / length * travel, y: hero.position.y + dy / length * travel });
        if (state.status === 'paused' && state.activeUnitId === player.id) await issue('wait');
        continue;
    }

    if (edgeDistance(hero, target) <= 1.5 + 1e-6 && canUseContact(view, target)) {
        lastTargetId = target.id;
        await issue('attack', { abilityId: 'basic-attack', targetIds: [target.id] });
        pendingRetreat = true;
        continue;
    }
    if (view.turnBudget?.[player.id]?.movement > 0) {
        const dx = target.position.x - hero.position.x;
        const dy = target.position.y - hero.position.y;
        const length = Math.hypot(dx, dy) || 1;
        const desired = Number(hero.radiusMeters || .5) + Number(target.radiusMeters || .5) + 1.2;
        const travel = Math.min(Number(hero.speedMeters || 6), Math.max(0, length - desired));
        if (travel > 1e-6) await issue('move', { x: hero.position.x + dx / length * travel, y: hero.position.y + dy / length * travel });
    }
    // Movement and main action can share one player turn. Re-read after the
    // movement because the contact ledger is rebuilt by the engine.
    if (state.status === 'paused' && state.activeUnitId === player.id) {
        const afterMove = await request(`/${created.id}`);
        const afterHero = afterMove.combatants.find(unit => unit.id === player.id);
        const afterTarget = afterMove.combatants.find(unit => unit.id === target.id);
        if (afterTarget && living(afterTarget) && edgeDistance(afterHero, afterTarget) <= 1.5 + 1e-6 && canUseContact(afterMove, afterTarget)) {
            state = afterMove;
            lastTargetId = target.id;
            await issue('attack', { abilityId: 'basic-attack', targetIds: [target.id] });
            pendingRetreat = true;
        } else await issue('wait');
    }
    if (remaining === 0) break;
}

let finalState = await request(`/${created.id}`);
if (finalState.status === 'completed') finalState = await request(`/${created.id}/finalize`, { method: 'POST', body: JSON.stringify({ commandId: 'guerrilla-full-finalize', expectedVersion: finalState.version }) });
const replay = await request(`/${created.id}/replay`);
const events = replay.events;
const checks = events.filter(event => event.type === 'attack_check').map(event => event.payload);
const heroChecks = checks.filter(check => check.actorId === player.id);
const enemyChecks = checks.filter(check => check.actorId !== player.id);
const finalHero = finalState.combatants.find(unit => unit.id === player.id);
const enemyStates = finalState.combatants.filter(unit => unit.side === 'enemy').reduce((out, unit) => ({ ...out, [unit.state]: (out[unit.state] || 0) + 1 }), {});
const knownEnemyIds = new Set();
let maxKnownEnemies = 0;
for (const event of events) {
    if (event.type === 'intel_detected' && event.payload?.observerId === player.id && event.payload?.targetId) knownEnemyIds.add(event.payload.targetId);
    if (event.type === 'intel_lost' && event.payload?.observerId === player.id && event.payload?.targetId) knownEnemyIds.delete(event.payload.targetId);
    maxKnownEnemies = Math.max(maxKnownEnemies, knownEnemyIds.size);
}
const report = {
    format: 'reincarnation-last-save-100-zombies-guerrilla-full-test',
    version: 1,
    generatedAt: new Date().toISOString(),
    sourcePath: path.relative(project, sourcePath),
    formalSourcePath: path.relative(project, formalPath),
    battleId: created.id,
    replayHash: replay.replayHash,
    strategy: state.strategy,
    input: { enemyCount: enemies.length, formalWeaponPanel: formalWeapon, formalPlayerPanel: formalPlayer, player: player, battlefield: encounter.battlefield },
    result: {
        status: finalState.status,
        winner: finalState.finalResult?.winner,
        round: finalState.round,
        player: { hp: finalHero?.hp, maxHp: finalHero?.maxHp, state: finalHero?.state, kills: finalHero?.kills, position: finalHero?.position },
        enemyStates,
        remainingEnemies: finalState.combatants.filter(unit => unit.side === 'enemy' && living(unit)).length,
        playerAttackChecks: heroChecks.length,
        playerHits: heroChecks.filter(check => ['hit', 'miracle'].includes(check.outcome)).length,
        playerDamage: heroChecks.reduce((sum, check) => sum + Number(check.applied?.hpDamage || 0), 0),
        enemyAttackChecks: enemyChecks.length,
        enemyHits: enemyChecks.filter(check => ['hit', 'miracle'].includes(check.outcome)).length,
        enemyDamage: enemyChecks.reduce((sum, check) => sum + Number(check.applied?.hpDamage || 0), 0),
        stealthEntered: events.filter(event => event.type === 'stealth_entered' && event.payload?.actorId === player.id).length,
        stealthBroken: events.filter(event => event.type === 'stealth_broken' && event.payload?.actorId === player.id).length,
        retreatMoves: actions.filter(action => action.type === 'move').length,
        maxKnownEnemies,
        maxContactAttackers: Math.max(0, ...events.filter(event => event.type === 'melee_slots_allocated' && event.payload?.targetId === player.id).map(event => event.payload?.attackerIds?.length || 0)),
        hashAligned: finalState.finalResult?.eventHash === finalState.eventHash,
    },
    actions,
    keyEvents: events.filter(event => ['stealth_entered', 'stealth_broken', 'intel_detected', 'intel_check', 'noise_emitted', 'melee_slots_allocated', 'attack_check', 'unit_state_changed', 'combat_completed'].includes(event.type)).slice(-500),
    replay,
};
const outputPath = path.join(project, '.test', 'last-save-100-zombies-guerrilla-full-result.json');
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
assert.ok(['completed', 'paused'].includes(report.result.status));
assert.equal(report.result.hashAligned, true);
assert.equal(report.result.enemyStates.active + (report.result.enemyStates.dying || 0) + (report.result.enemyStates.dead || 0), 100);
console.log(JSON.stringify({ ok: true, outputPath, battleId: report.battleId, result: report.result }, null, 2));
await new Promise(resolve => server.close(resolve));
