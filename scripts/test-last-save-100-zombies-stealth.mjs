import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCombatRouter } from '../combat/router.js';

// This regression deliberately starts from the latest persisted client save.
// It does not call engine internals or install a test-only route: all actions
// go through the same router used by the web terminal.
const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test', 'last-save-combat-debug-final.json');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const savedState = source.client.state;
const engage = process.argv.includes('--engage');
const root = path.resolve(path.dirname(sourcePath), 'last-save-stealth-api');
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
    try { body = JSON.parse(raw); } catch { throw new Error(`${response.status} ${response.headers.get('content-type') || ''}: ${raw.slice(0, 240)}`); }
    if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
    return body;
};

const heroSource = savedState.combatants.find(unit => unit.side === 'player');
assert.ok(heroSource, '最后存档没有玩家单位');
const player = structuredClone(heroSource);
player.id = 'last-save-stealth-hero';
player.name = `${heroSource.name || '主角'} · 潜行复测`;
player.controller = 'player';
player.position = { x: -22, y: -3.3 };
player.initiativeDC = 1000;
player.intelProfile = {
    presence: 'concealed',
    stealthBonus: 20,
    perceptionBonus: 0,
    commandBonus: 0,
    hearingMeters: 15,
    intelligenceRangeMeters: 0,
    intelligenceBonus: 0,
    movementNoiseMeters: 3,
    attackNoiseMeters: 18,
};
player.tacticalProfile = { archetype: 'scattered', groupId: 'last-save-stealth-hero', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 };

const enemies = savedState.combatants.filter(unit => unit.side === 'enemy').map((unit, index) => {
    const enemy = structuredClone(unit);
    enemy.id = `last-save-stealth-zombie-${String(index + 1).padStart(3, '0')}`;
    enemy.controller = 'ai';
    enemy.initiativeDC = -100;
    enemy.visionMeters = 20;
    enemy.intelProfile = {
        presence: 'obvious',
        stealthBonus: 0,
        perceptionBonus: 0,
        commandBonus: 0,
        hearingMeters: 4,
        intelligenceRangeMeters: 0,
        intelligenceBonus: 0,
        movementNoiseMeters: 12,
        attackNoiseMeters: 32,
    };
    enemy.tacticalProfile = { archetype: 'scattered', groupId: 'last-save-scattered-zombies', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 };
    return enemy;
});
assert.equal(enemies.length, 100, '最后存档应包含 100 个丧尸实体');

const encounter = {
    title: '最后存档人物 · 潜行接敌 · 1 对 100 丧尸',
    location: savedState.location || '压力测试场 · 开阔地',
    description: '使用最后存档人物与原二维坐标，玩家只进行潜行、移动和等待，不主动攻击；验证视觉/听觉情报、潜行噪声和敌方局部追踪。',
    battlefield: structuredClone(savedState.battlefield),
    combatants: [player, ...enemies],
};

try {
    const created = await request('/sessions', { method: 'POST', body: JSON.stringify({
        transient: true,
        simulation: { source: 'last-save', scenarioId: 'last-save-100-zombies-stealth' },
        seed: 'last-save-stealth-regression-v1',
        mode: 'manual',
        encounter,
    }) });
    const started = await request(`/${created.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'last-save-stealth-start', expectedVersion: created.version }) });
    assert.equal(started.status, 'paused');
    assert.equal(started.activeUnitId, player.id);

    const compiled = await request(`/${created.id}/strategy/compile`, { method: 'POST', body: JSON.stringify({
        commandId: 'last-save-stealth-strategy',
        expectedVersion: started.version,
        text: engage ? '先潜行接敌，采用游击队战术分割目标，逐个击破，命中后立即撤离，避免与主群交战。' : '先潜行接敌，保持安静，避免主动攻击；只在确认安全时继续移动。',
        confirmed: true,
        mode: 'manual',
    }) });
    assert.equal(compiled.strategy.stealth, true);
    if (engage) assert.equal(compiled.strategy.guerrilla, true);

    const actions = [];
    const issue = async (commandId, expectedVersion, command) => {
        const body = await request(`/${created.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId, expectedVersion, actorId: player.id, ...command }) });
        actions.push({ commandId, type: command.type, version: body.version, round: body.round, status: body.status, player: body.combatants.find(unit => unit.id === player.id)?.position });
        return body;
    };

    let state = await issue('last-save-stealth-enter', compiled.version, { type: 'sneak' });
    assert.ok(state.combatants.find(unit => unit.id === player.id).statuses.some(status => status.id === 'stealth'));
    // Entering stealth consumes the current movement action. End that first
    // turn before issuing the first six-meter approach step.
    state = await issue('last-save-stealth-enter-wait', state.version, { type: 'wait' });

    // Walk the saved character through the same open field in six-meter
    // increments.  Each wait hands control to the AI horde and starts the next
    // player turn; the loop stops after the first confirmed detection or six
    // rounds, whichever comes first.
    const waypoints = [-16, -10, -4, 2, 8, 14];
    const detections = () => combat.repository.events(created.id).filter(event => event.type === 'intel_detected' && event.payload?.targetId === player.id && event.payload?.observerId !== player.id);
    for (const [index, x] of waypoints.entries()) {
        state = await issue(`last-save-stealth-move-${index + 1}`, state.version, { type: 'move', x, y: -3.3 });
        state = await issue(`last-save-stealth-wait-${index + 1}`, state.version, { type: 'wait' });
        if (detections().length) break;
    }

    let engagement = null;
    if (engage) {
        // Once an enemy has a confirmed visual record, continue through the
        // same player command endpoint until one target is in melee range.
        // Movement remains bounded by the unit's normal six-meter budget; no
        // teleport or engine-internal shortcut is used.
        for (let step = 0; step < 8 && !engagement; step += 1) {
            const view = await request(`/${created.id}`);
            const heroView = view.combatants.find(unit => unit.id === player.id);
            const known = view.combatants.filter(unit => unit.side === 'enemy' && unit.state === 'active' && view.intel.knowledge[unit.id]?.[player.id]?.canTarget).sort((a, b) => Math.hypot(a.position.x - heroView.position.x, a.position.y - heroView.position.y) - Math.hypot(b.position.x - heroView.position.x, b.position.y - heroView.position.y));
            const target = known[0];
            if (!target) break;
            const centerDistance = Math.hypot(target.position.x - heroView.position.x, target.position.y - heroView.position.y);
            const edgeDistance = centerDistance - Number(heroView.radiusMeters || .5) - Number(target.radiusMeters || .5);
            if (edgeDistance > 1.5 + 1e-6) {
                const desiredCenter = Number(heroView.radiusMeters || .5) + Number(target.radiusMeters || .5) + 1.2;
                const travel = Math.min(Number(heroView.speedMeters || 6), Math.max(0, centerDistance - desiredCenter));
                if (travel <= 1e-6) break;
                const ratio = travel / centerDistance;
                state = await issue(`last-save-stealth-engage-move-${step + 1}`, state.version, { type: 'move', x: heroView.position.x + (target.position.x - heroView.position.x) * ratio, y: heroView.position.y + (target.position.y - heroView.position.y) * ratio });
                const afterMove = await request(`/${created.id}`);
                const afterHero = afterMove.combatants.find(unit => unit.id === player.id);
                const afterTarget = afterMove.combatants.find(unit => unit.id === target.id);
                const afterEdge = Math.hypot(afterTarget.position.x - afterHero.position.x, afterTarget.position.y - afterHero.position.y) - Number(afterHero.radiusMeters || .5) - Number(afterTarget.radiusMeters || .5);
                if (afterEdge > 1.5 + 1e-6) state = await issue(`last-save-stealth-engage-wait-${step + 1}`, state.version, { type: 'wait' });
            } else {
                state = await issue('last-save-stealth-engage-attack', state.version, { type: 'attack', abilityId: 'basic-attack', targetIds: [target.id] });
                engagement = { targetId: target.id, targetName: target.name, beforeEdgeDistance: edgeDistance, statusAfterAttack: state.status };
            }
        }
        // Guerrilla separation: after the strike, use the next available
        // player movement action to break contact and pull the confirmed
        // target away from the main horde. This is still a normal coordinate
        // command, so collision/boundary/speed rules remain authoritative.
        if (engagement && state.status === 'paused' && state.activeUnitId === player.id) {
            const view = await request(`/${created.id}`);
            const heroView = view.combatants.find(unit => unit.id === player.id);
            const target = view.combatants.find(unit => unit.id === engagement.targetId);
            if (heroView && target) {
                const dx = heroView.position.x - target.position.x;
                const dy = heroView.position.y - target.position.y;
                const distance = Math.hypot(dx, dy) || 1;
                const travel = Math.min(Number(heroView.speedMeters || 6), 6);
                const destination = { x: heroView.position.x + dx / distance * travel, y: heroView.position.y + dy / distance * travel };
                state = await issue('last-save-stealth-guerrilla-retreat', state.version, { type: 'move', x: destination.x, y: destination.y });
                const afterRetreat = state.combatants.find(unit => unit.id === player.id);
                engagement.retreat = { performed: true, position: afterRetreat.position, distanceFromTarget: Math.hypot(afterRetreat.position.x - target.position.x, afterRetreat.position.y - target.position.y) - Number(afterRetreat.radiusMeters || .5) - Number(target.radiusMeters || .5) };
            }
        }
    }

    const debug = await request(`/${created.id}/debug`);
    const replay = await request(`/${created.id}/replay`);
    const events = replay.events;
    const detectionEvents = events.filter(event => event.type === 'intel_detected' && event.payload?.targetId === player.id && event.payload?.observerId !== player.id);
    const detectionChecks = events.filter(event => event.type === 'intel_check' && event.payload?.targetId === player.id && event.payload?.observerId !== player.id);
    const contactEvents = events.filter(event => event.type === 'melee_slots_allocated' && event.payload?.targetId === player.id);
    const meleeRevealEvents = events.filter(event => event.type === 'intel_detected' && event.payload?.source === 'melee_contact' && event.payload?.targetId === player.id && event.payload?.observerId !== player.id);
    const current = await request(`/${created.id}`);
    // Noise is retained in state even when no listener was close enough to
    // warrant a separate `noise_emitted` event.
    const noise = (current.intel?.noise || []).filter(item => item.actorId === player.id && item.reason === 'movement');
    const enemyKnowledge = current.combatants.filter(unit => unit.side === 'enemy' && current.intel.knowledge[unit.id]?.[player.id]?.canTarget).map(unit => ({ id: unit.id, position: unit.position, knowledge: current.intel.knowledge[unit.id][player.id] }));
    const report = {
        format: 'reincarnation-last-save-100-zombies-stealth-test',
        version: 1,
        generatedAt: new Date().toISOString(),
        sourcePath: path.relative(path.resolve('.'), sourcePath),
        battleId: created.id,
        replayHash: replay.replayHash,
        input: {
            title: encounter.title,
            combatantCount: encounter.combatants.length,
            player: { id: player.id, sourceId: heroSource.id, name: player.name, hp: player.hp, maxHp: player.maxHp, ep: player.ep, maxEp: player.maxEp, position: player.position, intelProfile: player.intelProfile },
            enemy: { count: enemies.length, sourceTemplateIds: [...new Set(enemies.map(unit => unit.templateId))], visionMeters: 20, hearingMeters: 4, archetype: 'scattered' },
            strategy: compiled.strategy,
            waypoints,
        },
        result: {
            status: current.status,
            round: current.round,
            player: current.combatants.find(unit => unit.id === player.id),
            stealthActive: current.combatants.find(unit => unit.id === player.id)?.statuses?.some(status => status.id === 'stealth') || false,
            detectionCheckCount: detectionChecks.length,
            detectionCount: detectionEvents.length,
            firstDetection: detectionEvents[0] ? { round: detectionEvents[0].round, sequence: detectionEvents[0].sequence, ...detectionEvents[0].payload } : null,
            enemyKnownCount: enemyKnowledge.length,
            enemyKnown: enemyKnowledge.slice(0, 20),
            attackCheckCount: events.filter(event => event.type === 'attack_check').length,
            playerMeleeSlotAllocations: contactEvents.length,
            maxContactAttackers: Math.max(0, ...contactEvents.map(event => event.payload?.attackerIds?.length || 0)),
            maxContactWaitlist: Math.max(0, ...contactEvents.map(event => event.payload?.waitingCount || 0)),
            engagement,
            stealthBroken: events.some(event => event.type === 'stealth_broken' && event.payload?.actorId === player.id),
            meleeRevealCount: meleeRevealEvents.length,
            movementNoise: noise.map(item => ({ round: item.round, radiusMeters: item.radiusMeters, position: item.position })),
            maxMovementNoiseMeters: Math.max(0, ...noise.map(item => Number(item.radiusMeters || 0))),
        },
        debug: { raw: debug.raw, hydration: debug.hydration, projected: debug.projected },
        actions,
        keyEvents: events.filter(event => ['stealth_entered', 'stealth_broken', 'intel_check', 'intel_detected', 'intel_lost', 'noise_emitted', 'unit_moved', 'unit_searching', 'unit_waited'].includes(event.type)).slice(-240),
    };
    assert.equal(report.input.combatantCount, 101);
    if (engage) {
        assert.ok(report.result.attackCheckCount > 0, '潜行接敌复测没有产生攻击检定');
        assert.equal(report.result.stealthBroken, true, '攻击后应立即破隐');
        assert.ok(report.result.engagement?.targetId, '潜行接敌复测没有记录攻击目标');
        assert.ok(report.result.meleeRevealCount > 0, '近战目标没有获得攻击者情报');
        assert.equal(report.result.engagement?.retreat?.performed, true, '游击队突袭后没有执行脱离');
    } else assert.equal(report.result.attackCheckCount, 0, '潜行复测不应主动攻击');
    assert.ok(report.result.maxMovementNoiseMeters <= 3, '潜行移动噪声不得超过 3m');
    assert.ok(report.result.maxContactAttackers <= 8, '单目标近战接触位不得超过 8');
    assert.ok(report.result.detectionCheckCount >= report.result.detectionCount, '情报检定计数不一致');
    const outputPath = path.resolve(path.dirname(sourcePath), engage ? 'last-save-100-zombies-stealth-combat-result.json' : 'last-save-100-zombies-stealth-result.json');
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, outputPath, battleId: report.battleId, result: { status: report.result.status, round: report.result.round, detectionCheckCount: report.result.detectionCheckCount, detectionCount: report.result.detectionCount, enemyKnownCount: report.result.enemyKnownCount, attackCheckCount: report.result.attackCheckCount, meleeRevealCount: report.result.meleeRevealCount, retreatPerformed: report.result.engagement?.retreat?.performed || false, maxContactAttackers: report.result.maxContactAttackers, maxMovementNoiseMeters: report.result.maxMovementNoiseMeters } }, null, 2));
} finally {
    await new Promise(resolve => server.close(resolve));
}
