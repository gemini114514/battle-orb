import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCombatRouter } from '../combat/router.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test', 'vibe-combat-api');
fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const combat = createCombatRouter(root);
const app = express(); app.use(express.json()); app.use('/api/combat', combat.router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/combat`;
const request = async (route, options = {}) => { const response = await fetch(`${base}${route}`, { headers: { 'Content-Type': 'application/json' }, ...options }); const body = await response.json(); return { response, body }; };

try {
    // Reproduce an old V1 row: units and zones exist, but no battlefield or
    // continuous positions were persisted.  The debug route must expose both
    // the raw deficiency and the deterministic V2 projection.
    const legacyState = { id: 'legacy-spatial-debug', storySessionId: 'legacy-story', status: 'paused', version: 3, rulesetVersion: 'v1-legacy', seed: 'legacy-seed', combatants: [
        { id: 'legacy-player', templateId: 'legacy-player', name: '旧主角', side: 'player', state: 'active', zoneId: 'front', hp: 20, maxHp: 20 },
        { id: 'legacy-enemy', templateId: 'legacy-enemy', name: '旧敌人', side: 'enemy', state: 'active', zoneId: 'front', hp: 20, maxHp: 20 },
    ], zones: [{ id: 'front', name: '前线' }] };
    combat.repository.insertSessionRow({ id: legacyState.id, storySessionId: legacyState.storySessionId, status: legacyState.status, version: legacyState.version, rulesetVersion: legacyState.rulesetVersion, seed: legacyState.seed, stateJson: JSON.stringify(legacyState), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const legacyDebug = await request(`/${legacyState.id}/debug`);
    assert.equal(legacyDebug.response.status, 200);
    assert.equal(legacyDebug.body.raw.hasBattlefield, false);
    assert.equal(legacyDebug.body.projected.hasBattlefield, true);
    assert.equal(legacyDebug.body.hydration.applied, true);
    assert.equal(legacyDebug.body.persistedAfter.hasBattlefield, true);
    assert.equal(legacyDebug.body.persistedAfter.missingPositions, 0);
    const persistedLegacy = combat.repository.get(legacyState.id);
    assert.equal(persistedLegacy.battlefield.shape, 'rectangle');
    assert.equal(persistedLegacy.combatants.filter(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y))).length, 0);
    const legacyLoaded = await request(`/${legacyState.id}`);
    assert.equal(legacyLoaded.body.battlefield.shape, 'rectangle');
    assert.ok(Number.isFinite(legacyLoaded.body.combatants[0].position.x));

    const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ seed: 'api-seed', mode: 'manual', storySessionId: 'story-1', encounter: { title: 'API test', combatants: [{ id: 'p', name: 'P', side: 'player', hp: 100, maxHp: 100, attack: 100, attackModifier: 100 }, { id: 'e', name: 'E', side: 'enemy', hp: 10, maxHp: 10, attackModifier: -100 }] } }) });
    assert.equal(created.response.status, 201); const battle = created.body;
    const commandId = 'start-idempotent';
    const started = await request(`/${battle.id}/start`, { method: 'POST', body: JSON.stringify({ commandId, expectedVersion: battle.version }) });
    assert.equal(started.response.status, 200); assert.equal(started.body.status, 'paused');
    const repeated = await request(`/${battle.id}/start`, { method: 'POST', body: JSON.stringify({ commandId, expectedVersion: battle.version }) });
    assert.equal(repeated.response.status, 200); assert.equal(repeated.body.version, started.body.version);
    const invalidCommand = await request(`/${battle.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'debug-invalid-target', expectedVersion: started.body.version, type: 'attack', actorId: started.body.activeUnitId, abilityId: 'basic-attack', targetIds: ['not-present'] }) });
    assert.equal(invalidCommand.response.status, 400); assert.equal(invalidCommand.body.debug.method, 'POST'); assert.match(invalidCommand.body.debug.error.message, /请选择目标/);
    const conflict = await request(`/${battle.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'stale', expectedVersion: battle.version, type: 'wait', actorId: started.body.activeUnitId }) });
    assert.equal(conflict.response.status, 409);
    const action = await request(`/${battle.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'hit', expectedVersion: started.body.version, type: 'attack', actorId: started.body.activeUnitId, abilityId: 'basic-attack', targetIds: ['e'] }) });
    assert.equal(action.response.status, 200); assert.equal(action.body.status, 'completed');
    const replay = await request(`/${battle.id}/replay`); assert.equal(replay.response.status, 200); assert.ok(replay.body.replayHash); assert.ok(replay.body.events.length > 3);
    const narrative = await request(`/${battle.id}/narrative-bundle`); assert.equal(narrative.response.status, 200); assert.equal(narrative.body.bundle.winner, 'player'); assert.equal(narrative.body.bundle.schema, 'vibe-combat-result-outline/v3'); assert.ok(Array.isArray(narrative.body.bundle.participants)); assert.equal('finalState' in narrative.body.bundle, false); assert.match(narrative.body.bundle.battleDsl, /BATTLE_RESULT_DSL v1/); assert.match(narrative.body.bundle.battleDsl, /ENGAGE/); assert.match(narrative.body.bundle.battleDsl, /KILL/);
    const finalized = await request(`/${battle.id}/finalize`, { method: 'POST', body: JSON.stringify({ commandId: 'finalize', expectedVersion: action.body.version }) }); assert.equal(finalized.response.status, 200); assert.ok(finalized.body.finalizedAt);

    // Simulator sessions retain the exact same router/event API while never
    // reaching the persistent combat store. This is the boundary used by the
    // web simulator.
    const persistentCount = combat.repository.sessionCount();
    const simulation = await request('/sessions', { method: 'POST', body: JSON.stringify({ transient: true, simulation: { source: 'combat-simulator', scenarioId: 'same-tier-horde' }, seed: 'simulation-api-seed', mode: 'manual', encounter: { title: 'Simulation API test', combatants: [{ id: 'sp', name: '模拟主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, attack: 100, attackModifier: 100 }, { id: 'se', name: '模拟敌人', side: 'enemy', hp: 10, maxHp: 10, attackModifier: -100, abilities: [{ id: 'basic-attack', name: '远程基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 10, cooldownRounds: 0, targetCount: 1, aoe: false }] }] } }) });
    assert.equal(simulation.response.status, 201); assert.equal(simulation.body.transient, true); assert.equal(simulation.body.storySessionId, null);
    assert.ok(combat.repository.transient.has(simulation.body.id));
    assert.equal(combat.repository.sessionCount(), persistentCount, 'simulator wrote persistent combat store');
    const simStart = await request(`/${simulation.body.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'simulation-start', expectedVersion: simulation.body.version }) });
    assert.equal(simStart.response.status, 200); assert.equal(simStart.body.status, 'paused');
    const simResult = await request(`/${simulation.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'simulation-hit', expectedVersion: simStart.body.version, type: 'attack', actorId: simStart.body.activeUnitId, abilityId: 'basic-attack', targetIds: ['se'] }) });
    assert.equal(simResult.response.status, 200); assert.equal(simResult.body.status, 'completed');
    const simReplay = await request(`/${simulation.body.id}/replay`); assert.equal(simReplay.response.status, 200); assert.ok(simReplay.body.events.length > 3);
    assert.equal(combat.repository.sessionCount(), persistentCount, 'simulator actions wrote persistent combat store');

    // Full API stealth simulation: 1 player against a 100-unit scattered
    // horde.  The player explicitly enters stealth through the generic
    // commands endpoint; no test-only server hook or singleton state is used.
    const stealthHorde = await request('/sessions', { method: 'POST', body: JSON.stringify({ transient: true, simulation: { source: 'combat-simulator', scenarioId: 'stealth-100-scattered-horde' }, seed: 'api-stealth-horde-v1', mode: 'manual', encounter: {
        title: 'API 潜行模拟 · 1 对 100 本能丧尸', battlefield: { shape: 'rectangle', widthMeters: 160, heightMeters: 80, center: { x: 0, y: 0 } },
        combatants: [
            { id: 'stealth-player', name: '潜行测试者', side: 'player', controller: 'player', hp: 100, maxHp: 100, ep: 8, maxEp: 8, attack: 54, magicAttack: 38, attackModifier: 5, defenseDC: 34, initiativeDC: 1000, armor: 14, resistance: 10, visionMeters: 30, position: { x: -20, y: 0 }, intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'stealth-player', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 } },
            { id: 'stealth-zombies', name: '本能丧尸', side: 'enemy', controller: 'ai', count: 100, hp: 56, maxHp: 56, ep: 8, maxEp: 8, attack: 9, magicAttack: 2, attackModifier: 5, defenseDC: 50, initiativeDC: -100, armor: 0, resistance: 0, visionMeters: 20, position: { x: 20, y: 0 }, distribution: { style: 'scattered', radiusMeters: 16, spacingMeters: 1.25, jitterMeters: 1.2 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 4, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'stealth-zombies', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 } },
        ],
    } }) });
    assert.equal(stealthHorde.response.status, 201);
    const zombiePositions = stealthHorde.body.combatants.filter(unit => unit.side === 'enemy').map(unit => unit.position);
    assert.equal(zombiePositions.length, 100);
    assert.ok(new Set(zombiePositions.map(position => `${position.x}:${position.y}`)).size > 90, '散落丧尸不应退化为重复坐标');
    assert.ok(new Set(zombiePositions.map(position => position.y)).size > 40, '散落丧尸不应生成整齐方阵行');
    const stealthStart = await request(`/${stealthHorde.body.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-start', expectedVersion: stealthHorde.body.version }) });
    assert.equal(stealthStart.response.status, 200); assert.equal(stealthStart.body.status, 'paused'); assert.equal(stealthStart.body.activeUnitId, 'stealth-player');
    const compiledStealth = await request(`/${stealthHorde.body.id}/strategy/compile`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-strategy', expectedVersion: stealthStart.body.version, text: '先潜行接敌，采用游击队战术分割目标，逐个击破，命中后立即撤离，避免主群交战', confirmed: true, mode: 'manual' }) });
    assert.equal(compiledStealth.response.status, 200); assert.equal(compiledStealth.body.strategy.stealth, true);
    assert.equal(compiledStealth.body.strategy.guerrilla, true);
    const stealthEntered = await request(`/${stealthHorde.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-enter', expectedVersion: compiledStealth.body.version, type: 'sneak', actorId: 'stealth-player' }) });
    assert.equal(stealthEntered.response.status, 200); assert.ok(stealthEntered.body.combatants.find(unit => unit.id === 'stealth-player').statuses.some(status => status.id === 'stealth'));
    const stealthWaited = await request(`/${stealthHorde.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-wait', expectedVersion: stealthEntered.body.version, type: 'wait', actorId: 'stealth-player' }) });
    assert.equal(stealthWaited.response.status, 200); assert.equal(stealthWaited.body.status, 'paused');
    const stealthMoved = await request(`/${stealthHorde.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-move', expectedVersion: stealthWaited.body.version, type: 'move', actorId: 'stealth-player', x: -16, y: 0 }) });
    assert.equal(stealthMoved.response.status, 200); assert.ok(stealthMoved.body.intel.noise.some(noise => noise.actorId === 'stealth-player' && noise.reason === 'movement' && noise.radiusMeters <= 3));
    const stealthReplay = await request(`/${stealthHorde.body.id}/replay`); assert.equal(stealthReplay.response.status, 200);
    const stealthEvents = stealthReplay.body.events;
    assert.ok(stealthEvents.some(event => event.type === 'stealth_entered' && event.payload.actorId === 'stealth-player'));
    assert.equal(stealthEvents.filter(event => event.type === 'attack_check').length, 0, '远距离潜行 1v100 不应无目标自动进入交战');
    assert.equal(stealthEvents.filter(event => event.type === 'melee_slots_allocated' && event.payload.targetId === 'stealth-player').length, 0, '潜行状态不应提前分配丧尸近战接触位');
    const enemyKnowledge = stealthMoved.body.combatants.filter(unit => unit.side === 'enemy').map(unit => stealthMoved.body.intel.knowledge[unit.id]?.['stealth-player']).filter(Boolean);
    assert.equal(enemyKnowledge.length, 0, '远距离潜行后不应出现丧尸对玩家的情报记录');

    // Generic command path also verifies the balancing guard: an actual
    // melee attack immediately breaks stealth and reveals the attacker.
    const stealthBreak = await request('/sessions', { method: 'POST', body: JSON.stringify({ transient: true, simulation: { source: 'combat-simulator', scenarioId: 'stealth-melee-break' }, seed: 'api-stealth-break-v1', mode: 'manual', encounter: {
        title: 'API 潜行破隐 · 近战兜底', battlefield: { shape: 'rectangle', widthMeters: 40, heightMeters: 20, center: { x: 0, y: 0 } },
        combatants: [
            { id: 'break-player', name: '潜行者', side: 'player', controller: 'player', hp: 100, maxHp: 100, attack: 100, magicAttack: 10, attackModifier: 100, defenseDC: 50, initiativeDC: 1000, visionMeters: 30, position: { x: 0, y: 0 }, intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'break-player', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 0 } },
            { id: 'break-enemy', name: '近战目标', side: 'enemy', controller: 'ai', hp: 10, maxHp: 10, attack: 4, magicAttack: 0, attackModifier: -100, defenseDC: 50, initiativeDC: -100, visionMeters: 1, position: { x: 1.5, y: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 1, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'break-enemy', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 } },
        ],
    } }) });
    const breakStart = await request(`/${stealthBreak.body.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-break-start', expectedVersion: stealthBreak.body.version }) });
    const breakSneak = await request(`/${stealthBreak.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-break-enter', expectedVersion: breakStart.body.version, type: 'sneak', actorId: 'break-player' }) });
    const breakAttack = await request(`/${stealthBreak.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'api-stealth-break-attack', expectedVersion: breakSneak.body.version, type: 'attack', actorId: 'break-player', abilityId: 'basic-attack', targetIds: ['break-enemy'] }) });
    assert.equal(breakAttack.response.status, 200);
    const breakReplay = await request(`/${stealthBreak.body.id}/replay`); const breakEvents = breakReplay.body.events;
    assert.ok(breakEvents.some(event => event.type === 'stealth_broken' && event.payload.actorId === 'break-player'));
    assert.ok(breakEvents.some(event => event.type === 'intel_detected' && event.payload.observerId === 'break-enemy' && event.payload.targetId === 'break-player' && event.payload.source === 'melee_contact'));
    const stealthReportPath = path.resolve(root, '..', 'stealth-simulation-api-result.json');
    fs.writeFileSync(stealthReportPath, JSON.stringify({
        format: 'reincarnation-stealth-simulation-api-test', version: 1, generatedAt: new Date().toISOString(),
        horde: {
            battleId: stealthHorde.body.id, replayHash: stealthReplay.body.replayHash, status: stealthMoved.body.status, round: stealthMoved.body.round,
            combatantCount: stealthMoved.body.combatants.length, player: stealthMoved.body.combatants.find(unit => unit.id === 'stealth-player'),
            enemyKnownPlayerCount: enemyKnowledge.length, attackChecks: stealthEvents.filter(event => event.type === 'attack_check').length,
            playerMeleeSlotAllocations: stealthEvents.filter(event => event.type === 'melee_slots_allocated' && event.payload.targetId === 'stealth-player').length,
            noise: stealthMoved.body.intel.noise.filter(noise => noise.actorId === 'stealth-player'),
            keyEvents: stealthEvents.filter(event => ['stealth_entered', 'stealth_broken', 'intel_detected', 'intel_check', 'noise_emitted', 'melee_slots_allocated', 'attack_check'].includes(event.type)).slice(-120),
        },
        meleeBreak: {
            battleId: stealthBreak.body.id, replayHash: breakReplay.body.replayHash, status: breakAttack.body.status,
            keyEvents: breakEvents.filter(event => ['stealth_entered', 'stealth_broken', 'intel_detected', 'attack_check', 'action_resolved'].includes(event.type)),
        },
    }, null, 2));

    // V2 pipeline: a loose declaration is checked separately, then the combat
    // model supplies all fixed coordinates and local asset parameters.
    const declaration = { reason: '巡逻队遭遇伏击', battlefield: { kind: '空旷广场', shapeHint: 'circle', description: '敌人从正前方逼近' }, participants: [{ id: 'hero', name: '主角', side: 'player', source: 'existing', reference: '主角', state: '警戒，持剑', relativePosition: '中心' }, { id: 'raider', name: '袭击者', side: 'enemy', source: 'create', state: '持械接近', relativePosition: '正前方十米' }] };
    const declarationCheck = await request('/declaration/validate', { method: 'POST', body: JSON.stringify({ declaration }) }); assert.equal(declarationCheck.response.status, 200); assert.equal(declarationCheck.body.ok, true);
    const positionlessDeclaration = structuredClone(declaration); delete positionlessDeclaration.participants[1].relativePosition;
    const positionlessCheck = await request('/declaration/validate', { method: 'POST', body: JSON.stringify({ declaration: positionlessDeclaration }) }); assert.equal(positionlessCheck.body.ok, false); assert.ok(positionlessCheck.body.errors.some(item => item.code === 'declaration.participant_position_required'));
    const requiredAssets = [{ assetId: 'asset-v2-sword', fingerprint: 'equipment:short-sword:v1', kind: 'equipment', name: '测试短剑' }];
    const v2Model = { title: 'V2 坐标战场', location: '广场', battlefield: { shape: 'circle', name: '测试圆形战场', radiusMeters: 12, center: { x: 0, y: 0 } }, assetProfiles: [{ ...requiredAssets[0], combat: { minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, attackStyle: 'melee' } }], combatants: [
        { id: 'hero', declarationId: 'hero', name: '主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, ep: 5, maxEp: 5, attack: 100, magicAttack: 10, attackModifier: 100, defenseDC: 50, initiativeDC: 1000, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: -5, y: 0 }, facingDegrees: 0, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'squad', groupId: 'heroes', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 18 }, assetBindings: ['asset-v2-sword'], abilities: [{ id: 'basic-attack', name: '短剑挥砍', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
        { id: 'raider', declarationId: 'raider', name: '袭击者', side: 'enemy', controller: 'ai', hp: 10, maxHp: 10, ep: 0, maxEp: 0, attack: 4, magicAttack: 0, attackModifier: -100, defenseDC: 50, initiativeDC: -100, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: 5, y: 0 }, facingDegrees: 180, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'raiders', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 }, abilities: [{ id: 'basic-attack', name: '拳击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
    ] };
    const invalidModel = structuredClone(v2Model); invalidModel.combatants[1].abilities = [];
    const invalidCheck = await request('/model/validate', { method: 'POST', body: JSON.stringify({ declaration, model: invalidModel, requiredAssets }) }); assert.equal(invalidCheck.body.ok, false); assert.ok(invalidCheck.body.errors.some(item => item.code === 'model.unit_actions_missing'));
    const mismatchedAssetModel = structuredClone(v2Model); mismatchedAssetModel.assetProfiles[0].fingerprint = 'equipment:tampered';
    const mismatchedAssetCheck = await request('/model/validate', { method: 'POST', body: JSON.stringify({ declaration, model: mismatchedAssetModel, requiredAssets }) }); assert.equal(mismatchedAssetCheck.body.ok, false); assert.ok(mismatchedAssetCheck.body.errors.some(item => item.code === 'asset.profile_identity_mismatch'));
    const hordeDeclaration = structuredClone(declaration); hordeDeclaration.participants[1].count = 3;
    const countMismatchModel = structuredClone(v2Model);
    const countMismatchCheck = await request('/model/validate', { method: 'POST', body: JSON.stringify({ declaration: hordeDeclaration, model: countMismatchModel, requiredAssets }) }); assert.equal(countMismatchCheck.body.ok, false); assert.ok(countMismatchCheck.body.errors.some(item => item.code === 'model.declaration_count_mismatch'));
    const modelCheck = await request('/model/validate', { method: 'POST', body: JSON.stringify({ declaration, model: v2Model, requiredAssets }) }); assert.equal(modelCheck.response.status, 200); assert.equal(modelCheck.body.ok, true);
    const v2Created = await request('/sessions', { method: 'POST', body: JSON.stringify({ storySessionId: 'story-v2', mode: 'manual', seed: 'v2-coordinate-seed', encounter: v2Model, assetProfiles: v2Model.assetProfiles, preparation: { declaration, attempts: 1 } }) }); assert.equal(v2Created.response.status, 201); assert.equal(v2Created.body.battlefield.shape, 'circle');
    const v2Started = await request(`/${v2Created.body.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'v2-start', expectedVersion: v2Created.body.version }) }); assert.equal(v2Started.body.status, 'paused');
    const v2Moved = await request(`/${v2Created.body.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'v2-move', expectedVersion: v2Started.body.version, type: 'move', actorId: 'hero', x: -2, y: 0 }) }); assert.equal(v2Moved.response.status, 200); assert.deepEqual(v2Moved.body.combatants.find(item => item.id === 'hero').position, { x: -2, y: 0 });
    const v2Redo = await request(`/${v2Created.body.id}/redo`, { method: 'POST', body: JSON.stringify({ commandId: 'v2-redo', expectedVersion: v2Moved.body.version }) }); assert.equal(v2Redo.response.status, 200); assert.equal(v2Redo.body.combatants.find(item => item.id === 'hero').position.x, -2);
    const v2RedoEvents = await request(`/${v2Created.body.id}/events`); assert.ok(v2RedoEvents.body.events.some(event => event.type === 'command_redone'));
    const asset = await request('/assets/asset-v2-sword'); assert.equal(asset.response.status, 200); assert.equal(asset.body.combat.attackStyle, 'melee');
    const v2Events = v2RedoEvents; assert.ok(v2Events.body.events.some(event => event.type === 'unit_moved' && event.payload.distanceMeters === 3));
    console.log(JSON.stringify({ ok: true, battleId: battle.id, eventCount: replay.body.events.length, replayHash: replay.body.replayHash, simulationBattleId: simulation.body.id, simulationEvents: simReplay.body.events.length, coordinateBattleId: v2Created.body.id, coordinateEvents: v2Events.body.events.length }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
