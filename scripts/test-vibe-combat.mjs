import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CombatRepository } from '../combat/repository.js';
import { CombatEngine } from '../combat/engine.js';
import { compileStrategy } from '../combat/strategy.js';
import { runScript, scriptHash, testScript } from '../combat/sandbox.js';
import { applyDamage, checkOutcome, QUALITY_DC, targetCostMultiplier } from '../combat/rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test', 'vibe-combat');
fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const repository = new CombatRepository(root);
const engine = new CombatEngine(repository);
assert.equal(QUALITY_DC.SSS, 280); assert.equal(checkOutcome(98, 10, 999), 'miracle'); assert.equal(checkOutcome(2, 999, 1), 'disaster'); assert.equal(targetCostMultiplier(5), 3);
const overkillTarget = { hp: 6, thp: 0, state: 'active', dyingHits: 0 };
const overkillResult = applyDamage(overkillTarget, 14);
assert.equal(overkillResult.hpDamage, 6); assert.equal(overkillResult.overkill, 8); assert.equal(overkillResult.after.hp, 0);

function reload(id) { const state = repository.get(id); state.pendingEvents = []; return state; }
function commit(state) { state.version += 1; const events = state.pendingEvents.splice(0); repository.commit(state, events); return state; }
function baseUnit(side, extra = {}) { return { id: side, name: side, side, controller: side === 'enemy' ? 'ai' : 'player', hp: 100, maxHp: 100, attack: 20, attackModifier: 100, defenseDC: 50, zoneId: 'arena', ...extra }; }
function payload(seed, combatants, mode = 'auto') { return { seed, mode, encounter: { title: 'test', zones: [{ id: 'arena', name: 'arena', adjacent: [], capacity: 6 }], combatants } }; }
async function run(id) { const state = reload(id); await engine.start(state); commit(state); return state; }

// V1 archives had no battlefield or positions.  Loading such a record must
// still return a renderable V2 projection instead of an empty map.
const legacy = { id: 'legacy-v1', location: '旧战场', combatants: [
    { id: 'legacy-player', templateId: 'legacy-player', name: '旧主角', side: 'player', state: 'active', zoneId: 'front', hp: 20, thp: 0, maxHp: 20 },
    { id: 'legacy-enemy', templateId: 'legacy-enemy', name: '旧敌人', side: 'enemy', state: 'active', zoneId: 'front', hp: 20, thp: 0, maxHp: 20 },
] };
const legacyView = engine.publicState(legacy);
assert.equal(legacyView.battlefield.shape, 'rectangle');
assert.ok(Number.isFinite(legacyView.combatants[0].position.x));
assert.ok(Number.isFinite(legacyView.combatants[1].position.x));
const legacyWithSnapshot = { id: 'legacy-v1-snapshot', location: '旧战场', combatants: legacy.combatants.map(unit => ({ ...unit })), initialSnapshot: { combatants: legacy.combatants.map(unit => ({ ...unit })), zones: [] } };
const legacySnapshotView = engine.publicState(legacyWithSnapshot);
assert.ok(Number.isFinite(legacySnapshotView.initialSnapshot.combatants[0].position.x), '旧存档初始快照应补齐二维位置');

// Same seed/input produces the same deterministic chain even though battle IDs/timestamps differ.
const deterministicPayload = payload('fixed-seed', [baseUnit('player', { controller: 'ai' }), baseUnit('enemy')]);
const first = await run(engine.create(deterministicPayload).id);
const second = await run(engine.create(deterministicPayload).id);
assert.equal(first.lastEventHash, second.lastEventHash, 'deterministic event hashes differ');

// Manual mode stops exactly at the controlled unit and advances through an explicit command.
let manual = reload(engine.create(payload('manual', [baseUnit('player'), baseUnit('enemy', { attackModifier: -100 })], 'manual')).id);
manual.combatants.find(unit => unit.id === 'player').initiativeDC = 1000;
manual.combatants.find(unit => unit.id === 'enemy').initiativeDC = -100;
await engine.start(manual); assert.equal(manual.status, 'paused'); assert.equal(manual.pauseReason.type, 'manual_turn');
const manualInitiative = manual.pendingEvents.filter(event => event.type === 'initiative_roll');
const manualLock = manual.pendingEvents.find(event => event.type === 'initiative_order_locked');
const firstManualAttack = manual.pendingEvents.find(event => event.type === 'attack_check');
assert.equal(manualInitiative.length, 2, '行动前必须为全部存活单位完成先攻检定');
assert.ok(manualLock?.payload?.allUnitsRolled, '全部先攻完成后必须锁定行动顺序');
assert.equal(firstManualAttack, undefined, '手动暂停不能越过先攻阶段直接行动');
const versionBefore = manual.version;
await engine.command(manual, { expectedVersion: versionBefore, type: 'attack', actorId: manual.activeUnitId, targetIds: ['enemy'], abilityId: 'basic-attack' });
assert.ok(manual.sequence > 3); commit(manual);

// Stealth is an explicit player movement action, not an implicit property of
// every protagonist.  It must survive the round boundary, suppress the
// automatic visual reveal used for obvious targets, and break on attack.
let stealthAction = reload(engine.create(payload('stealth-action', [
    baseUnit('player', { position: { x: 0, y: 0 }, initiativeDC: 1000, intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 } }),
    baseUnit('enemy', { position: { x: 10, y: 0 }, initiativeDC: -100, visionMeters: 5, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 2, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 } }),
], 'manual')).id);
await engine.start(stealthAction);
await engine.command(stealthAction, { type: 'sneak', actorId: 'player' });
assert.ok(stealthAction.combatants.find(unit => unit.id === 'player').statuses.some(status => status.id === 'stealth'));
assert.equal(stealthAction.intel.knowledge.enemy.player, undefined);
assert.equal(stealthAction.pendingEvents.filter(event => event.type === 'stealth_entered').length, 1);
assert.equal(stealthAction.combatants.find(unit => unit.id === 'player').statuses.some(status => status.id === 'stealth'), true);
await engine.command(stealthAction, { type: 'unsneak', actorId: 'player' });
assert.equal(stealthAction.combatants.find(unit => unit.id === 'player').statuses.some(status => status.id === 'stealth'), false);
commit(stealthAction);

// A confirmed semi-automatic strategy uses the same generic action path to
// enter stealth before it ever selects a target. The round trigger stops this
// small regression at a player handoff instead of running an unbounded search.
let autoStealth = reload(engine.create(payload('auto-stealth-strategy', [
    baseUnit('player', { position: { x: -20, y: 0 }, controller: 'player', initiativeDC: 1000, visionMeters: 1, intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 7, attackNoiseMeters: 18 } }),
    baseUnit('enemy', { position: { x: 10, y: 0 }, initiativeDC: -100, visionMeters: 1, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 2, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 } }),
], 'semi')).id);
autoStealth.strategy = compileStrategy('先潜行接敌，保持安静。', { confirmed: true, takeoverTriggers: [{ field: 'round', operator: '>=', value: 1 }] });
await engine.start(autoStealth);
assert.equal(autoStealth.status, 'paused');
assert.equal(autoStealth.pauseReason.type, 'takeover_trigger');
assert.ok(autoStealth.combatants.find(unit => unit.id === 'player').statuses.some(status => status.id === 'stealth'));
assert.ok(autoStealth.pendingEvents.some(event => event.type === 'stealth_entered' && event.payload.source === 'strategy'));
commit(autoStealth);

// A manual turn preserves the actor after movement, then consumes the main action.
let tactical = reload(engine.create({ seed: 'movement-budget', mode: 'manual', encounter: { zones: [{ id: 'rear', name: 'rear', adjacent: ['front'] }, { id: 'front', name: 'front', adjacent: ['rear'] }], combatants: [baseUnit('player', { zoneId: 'rear', initiativeDC: 1000 }), baseUnit('enemy', { zoneId: 'front', attackModifier: -100 })] } }).id);
await engine.start(tactical); const tacticalActor = tactical.activeUnitId;
await engine.command(tactical, { type: 'move', actorId: tacticalActor, zoneId: 'front' });
assert.equal(tactical.activeUnitId, tacticalActor); assert.equal(tactical.status, 'paused'); assert.ok(tactical.turnBudget[tacticalActor].movementMeters >= 0, '兼容区域移动应使用移动点数而不是移动次数标记');
await engine.command(tactical, { type: 'attack', actorId: tacticalActor, abilityId: 'basic-attack', targetIds: ['enemy'] }); commit(tactical);

// Movement is a meter pool and remains available around the main action:
// move 4m, attack, then retreat 4m in the same player turn.
let movementPool = reload(engine.create(payload('movement-pool-combo', [
    baseUnit('player', { position: { x: -4.5, y: 0 }, speedMeters: 12, baseSpeedMeters: 12, initiativeDC: 1000, attackModifier: 100 }),
    baseUnit('enemy', { position: { x: 1, y: 0 }, initiativeDC: -100, attackModifier: -100, attributes: { strengthModifier: -100 } }),
], 'manual')).id);
await engine.start(movementPool);
await engine.command(movementPool, { type: 'move', actorId: 'player', x: -.5, y: 0 });
assert.equal(movementPool.activeUnitId, 'player');
assert.equal(Math.round(movementPool.turnBudget.player.movementMeters), 8, '移动4m后应保留8m移动点数');
await engine.command(movementPool, { type: 'attack', actorId: 'player', abilityId: 'basic-attack', targetIds: ['enemy'] });
assert.equal(movementPool.activeUnitId, 'player', '攻击后仍有移动点数时不应结束回合');
assert.equal(movementPool.turnBudget.player.main, 0);
await assert.rejects(() => engine.command(movementPool, { type: 'move', actorId: 'player', x: -4.5, y: 0 }), error => error.details?.blockingUnitIds?.includes('enemy'));
assert.equal(movementPool.combatants.find(unit => unit.id === 'player').position.x, -.5, '脱离检定失败时单位不得移动');

const rangedOnly = reload(engine.create(payload('ranged-does-not-block', [
    baseUnit('player', { position: { x: 0, y: 0 } }),
    baseUnit('enemy', { position: { x: 1, y: 0 }, abilities: [{ id: 'basic-attack', name: '远程攻击', actionType: 'main', minRangeMeters: 4, maxRangeMeters: 30, epCost: 0 }] }),
], 'manual')).id);
await engine.start(rangedOnly);
assert.deepEqual(engine.publicState(rangedOnly).movementBlockers.unitIds, [], '只有远程攻击能力的单位不得形成近战阻止');

const oneSidedMeleeRange = reload(engine.create(payload('one-sided-melee-range', [
    baseUnit('player', { position: { x: 0, y: 0 } }),
    baseUnit('enemy', { position: { x: 2.6, y: 0 } }),
], 'manual')).id);
await engine.start(oneSidedMeleeRange);
assert.deepEqual(engine.publicState(oneSidedMeleeRange).movementBlockers.unitIds, [], '玩家无法以近战基础攻击反击的单位不得形成移动阻止');

// A manually controlled player must be able to attack any mutually reachable
// melee blocker, not only the single target selected by the automatic policy.
// The movement-blocking relation and the player's attack-slot availability are
// both derived from the same contact geometry.
let playerCanAttackBlockers = reload(engine.create(payload('player-can-attack-blockers', [
    baseUnit('player', { position: { x: 0, y: 0 }, initiativeDC: 1000 }),
    baseUnit('enemy', { id: 'enemy-a', position: { x: 1.1, y: 0 }, initiativeDC: -100, attackModifier: -100 }),
    baseUnit('enemy', { id: 'enemy-b', position: { x: 0, y: 1.1 }, initiativeDC: -100, attackModifier: -100 }),
], 'manual')).id);
await engine.start(playerCanAttackBlockers);
delete playerCanAttackBlockers.intel.knowledge.player['enemy-b'];
const blockerView = engine.publicState(playerCanAttackBlockers);
assert.deepEqual(new Set(blockerView.movementBlockers.unitIds), new Set(['enemy-a', 'enemy-b']));
const legalBasicAttack = playerCanAttackBlockers.pauseReason.legalActions.find(item => item.id === 'basic-attack');
assert.ok(legalBasicAttack.legalTargetIds.includes('enemy-a'), '玩家应能攻击第一个近战阻止者');
assert.ok(legalBasicAttack.legalTargetIds.includes('enemy-b'), '玩家应能攻击第二个近战阻止者');
await engine.command(playerCanAttackBlockers, { type: 'attack', actorId: 'player', abilityId: 'basic-attack', targetIds: ['enemy-b'] });
assert.ok(playerCanAttackBlockers.pendingEvents.some(event => event.type === 'attack_check' && event.payload.actorId === 'player' && event.payload.targetId === 'enemy-b'));
commit(playerCanAttackBlockers);
commit(movementPool);

// Every melee-capable unit receives the default resident counterattack
// passive. It reacts after a melee attack even when the incoming attack
// misses, provided the defender remains alive, and it must not recurse.
let counterattack = reload(engine.create(payload('melee-counterattack', [
    baseUnit('player', { position: { x: -.5, y: 0 }, attackModifier: -100, hp: 100, maxHp: 100, initiativeDC: 1000 }),
    baseUnit('enemy', { position: { x: .5, y: 0 }, attackModifier: 100, attack: 5, hp: 100, maxHp: 100, initiativeDC: -100 }),
], 'manual')).id);
await engine.start(counterattack);
const counterPlayer = counterattack.combatants.find(unit => unit.id === 'player');
const counterEnemy = counterattack.combatants.find(unit => unit.id === 'enemy');
engine.updateKnowledge(counterattack, counterPlayer, counterEnemy, { source: 'visual', reason: 'counterattack_test', force: true });
engine.updateKnowledge(counterattack, counterEnemy, counterPlayer, { source: 'visual', reason: 'counterattack_test', force: true });
assert.ok(counterEnemy.passives.some(passive => passive.id === 'melee-counterattack' && passive.enabled), '近战单位缺少默认自动反击被动');
engine.resolveAttack(counterattack, counterPlayer, [counterEnemy], counterPlayer.abilities.find(ability => ability.id === 'basic-attack'));
const counterEvents = counterattack.pendingEvents;
const incomingAttack = counterEvents.find(event => event.type === 'attack_check' && event.payload.actorId === 'player');
const retaliation = counterEvents.find(event => event.type === 'attack_check' && event.payload.actorId === 'enemy' && event.payload.counterattack);
assert.equal(incomingAttack.payload.outcome, 'miss', '反击测试应覆盖近战未命中');
assert.ok(retaliation, '受击存活的近战单位未立即反击');
assert.equal(counterEvents.filter(event => event.type === 'counterattack_triggered').length, 1);
assert.equal(counterEvents.filter(event => event.type === 'attack_check' && event.payload.counterattack).length, 1, '反击不得递归触发');
assert.ok(counterPlayer.hp < counterPlayer.maxHp, '近战反击未造成结算伤害');
commit(counterattack);

// A target hidden at round start can become visible and enter contact range
// after a player move. The contact-slot ledger must be rebuilt before the
// follow-up attack, otherwise the client receives a false "slot allocated"
// rejection for a target that had no slot entry at all.
let revealAfterMove = reload(engine.create(payload('reveal-after-move', [
    baseUnit('player', { position: { x: 0, y: 0 }, speedMeters: 2, visionMeters: 3, initiativeDC: 1000, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 10, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 10 } }),
    baseUnit('enemy', { position: { x: 4, y: 0 }, attackModifier: -100, initiativeDC: -100, visionMeters: 3, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 10, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 10 } }),
], 'manual')).id);
await engine.start(revealAfterMove);
assert.equal(revealAfterMove.meleeSlots.targets.enemy, undefined);
await engine.command(revealAfterMove, { type: 'move', actorId: 'player', x: 2, y: 0 });
assert.ok(revealAfterMove.meleeSlots.targets.enemy?.attackerIds.includes('player'));
await engine.command(revealAfterMove, { type: 'attack', actorId: 'player', abilityId: 'basic-attack', targetIds: ['enemy'] }); commit(revealAfterMove);

// A contact body has exactly eight attack positions for one complete round.
// The remaining horde can move/search, but it cannot stack extra melee attacks
// into the same target on that round.
let slots = reload(engine.create(payload('eight-contact-slots', [
    baseUnit('player', { hp: 10000, maxHp: 10000, initiativeDC: 1000, position: { x: -.5, y: 0 }, radiusMeters: .1 }),
    baseUnit('enemy', { id: 'swarm', name: '围攻者', count: 12, attack: 1, attackModifier: 100, initiativeDC: -100, speedMeters: 20, position: { x: 0, y: 0 }, radiusMeters: .1 }),
], 'manual')).id);
await engine.start(slots);
assert.equal(slots.meleeSlots.targets.player.capacity, 8);
assert.equal(slots.meleeSlots.targets.player.attackerIds.length, 8);
assert.equal(slots.meleeSlots.targets.player.waitlistIds.length, 4);
await engine.command(slots, { type: 'wait', actorId: slots.activeUnitId });
assert.equal(slots.pendingEvents.filter(event => event.type === 'attack_check' && event.payload.targetId === 'player').length, 8);
commit(slots);

// Visual, hearing and explicit intelligence are separate audit sources.  A
// source is recorded in state rather than inferred from prose later.
let auditory = reload(engine.create(payload('auditory-source', [
    baseUnit('player', { position: { x: -20, y: 0 }, visionMeters: 1, intelProfile: { presence: 'concealed', stealthBonus: 100, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 32 } }),
    baseUnit('enemy', { position: { x: 10, y: 0 }, visionMeters: 1, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 1000, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 40, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 } }),
])).id);
engine.emitNoise(auditory, auditory.combatants.find(unit => unit.id === 'player'), { reason: 'test_auditory', radiusMeters: 40 });
assert.equal(auditory.intel.knowledge.enemy.player.source, 'auditory'); commit(auditory);

// Turning away does not erase a target that has not taken its turn yet. Once
// that target acts, the next visual refresh may downgrade the stale contact.
let turnVisibility = reload(engine.create(payload('turn-visibility', [
    baseUnit('player', { position: { x: 0, y: 0 }, facingDegrees: 0, visionMeters: 30, initiativeDC: 1000 }),
    baseUnit('enemy', { position: { x: 10, y: 0 }, facingDegrees: 180, initiativeDC: -100 }),
], 'manual')).id);
await engine.start(turnVisibility);
const turnObserver = turnVisibility.combatants.find(unit => unit.id === 'player');
const turnTarget = turnVisibility.combatants.find(unit => unit.id === 'enemy');
engine.updateKnowledge(turnVisibility, turnObserver, turnTarget, { source: 'visual', reason: 'turn_visibility_test', force: true });
turnObserver.facingDegrees = 180;
engine.refreshIntelligence(turnVisibility, { reason: 'turn_visibility_refresh', affectedIds: [turnObserver.id] });
assert.equal(turnVisibility.intel.knowledge.player.enemy.awareness, 'tracking');
turnVisibility.cursor = 2;
engine.refreshIntelligence(turnVisibility, { reason: 'turn_visibility_after_target_turn', affectedIds: [turnObserver.id] });
assert.equal(turnVisibility.intel.knowledge.player.enemy.awareness, 'suspicious');

// Every unit has a two-meter forced-visibility radius, regardless of facing.
turnTarget.position = { x: 1.5, y: 0 };
turnVisibility.cursor = 0;
engine.updateKnowledge(turnVisibility, turnObserver, turnTarget, { source: 'visual', reason: 'forced_visibility_test', force: true });
turnObserver.facingDegrees = 180;
engine.refreshIntelligence(turnVisibility, { reason: 'forced_visibility_refresh', affectedIds: [turnObserver.id] });
assert.equal(turnVisibility.intel.knowledge.player.enemy.awareness, 'tracking');
commit(turnVisibility);

let intel = reload(engine.create(payload('intel-source', [
    baseUnit('player', { position: { x: -20, y: 0 }, visionMeters: 1, intelProfile: { presence: 'concealed', stealthBonus: 100, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 18 } }),
    baseUnit('enemy', { position: { x: 10, y: 0 }, visionMeters: 1, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 45, intelligenceBonus: 1000, movementNoiseMeters: 12, attackNoiseMeters: 32 } }),
])).id);
engine.refreshIntelligence(intel, { initial: true, reason: 'test_intelligence' });
assert.equal(intel.intel.knowledge.enemy.player.source, 'intel'); commit(intel);

// A melee attack cannot remain anonymous: contact exposes the attacker even
// when the D100 attack check misses.
let meleeReveal = reload(engine.create(payload('melee-reveal', [
    baseUnit('player', { position: { x: -1, y: 0 }, initiativeDC: -100, attributes: { strengthModifier: 0, dexterityModifier: 1000, constitutionModifier: 0, spiritModifier: -100, charismaModifier: 0 }, intelProfile: { presence: 'concealed', stealthBonus: 1000, perceptionBonus: 0, commandBonus: 0, hearingMeters: 1, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 18 } }),
    baseUnit('enemy', { position: { x: 1, y: 0 }, initiativeDC: 1000, attackModifier: -100, intelProfile: { presence: 'cautious', stealthBonus: 0, perceptionBonus: -100, commandBonus: 0, hearingMeters: 1, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 7, attackNoiseMeters: 18 } }),
], 'manual')).id);
engine.updateKnowledge(meleeReveal, meleeReveal.combatants.find(unit => unit.id === 'enemy'), meleeReveal.combatants.find(unit => unit.id === 'player'), { source: 'visual', reason: 'test_setup', force: true });
await engine.start(meleeReveal);
assert.equal(meleeReveal.intel.knowledge.player.enemy.source, 'melee_contact');
assert.ok(meleeReveal.pendingEvents.some(event => event.type === 'intel_detected' && event.payload.source === 'melee_contact'));
commit(meleeReveal);

// A hive shares the first confirmed sighting.  The second node receives the
// target without an independent line-of-sight roll.
let hive = reload(engine.create(payload('hive-shares-intel', [
    baseUnit('player', { position: { x: -20, y: 0 }, initiativeDC: 1000, attributes: { strengthModifier: 0, dexterityModifier: 100, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'concealed', stealthBonus: 100, perceptionBonus: 0, commandBonus: 0, hearingMeters: 8, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 3, attackNoiseMeters: 18 } }),
    baseUnit('enemy', { id: 'hive-a', position: { x: 10, y: 0 }, visionMeters: 50, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 1000, charismaModifier: 0 }, tacticalProfile: { archetype: 'hive', groupId: 'hive-test', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 1000 } }),
    baseUnit('enemy', { id: 'hive-b', position: { x: 11.2, y: 0 }, visionMeters: 1, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: -100, charismaModifier: 0 }, tacticalProfile: { archetype: 'hive', groupId: 'hive-test', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 1000 } }),
], 'manual')).id);
await engine.start(hive);
assert.equal(hive.intel.knowledge['hive-b'].player.source, 'shared');
assert.ok(hive.pendingEvents.some(event => event.type === 'intel_shared'));
commit(hive);

// 100 zombies retain individual IDs but an AOE is processed as one deterministic action.
const massStart = performance.now();
let mass = reload(engine.create(payload('100-zombies', [baseUnit('player', { controller: 'ai', hp: 1000, maxHp: 1000, abilities: [{ id: 'purge', name: '横扫', type: 'true', power: 100, range: 'contact', targetCount: 100, aoe: true }] }), baseUnit('enemy', { name: '丧尸', count: 100, hp: 20, maxHp: 20, attackModifier: -100 })])).id);
await engine.start(mass); commit(mass);
const massMs = performance.now() - massStart;
assert.equal(mass.combatants.filter(unit => unit.side === 'enemy').length, 100);
assert.equal(mass.status, 'completed'); assert.equal(mass.finalResult.winner, 'player');
assert.equal(mass.finalResult.eventHash, mass.lastEventHash, 'settlement hash must point at the terminal ledger event');
assert.ok(massMs < 5000, '100 zombie scenario exceeded 5s test budget');

const thousandStart = performance.now();
// This is an AOE throughput test, not a fog-of-war test.  Give the synthetic
// caster explicit omnidirectional, long-range sensing so unseen outskirts do
// not intentionally stall the combat after V2 made target acquisition strict.
let thousand = reload(engine.create(payload('1000-hostiles', [baseUnit('player', { controller: 'ai', hp: 1000, maxHp: 1000, visionMeters: 1000, fovDegrees: 360, abilities: [{ id: 'wide-area', name: '大范围清扫', type: 'true', power: 100, range: 'far', targetCount: 1000, aoe: true }] }), baseUnit('enemy', { name: '压力实体', count: 1000, hp: 10, maxHp: 10, attackModifier: -100 })])).id);
await engine.start(thousand); commit(thousand); const thousandMs = performance.now() - thousandStart;
assert.equal(thousand.status, 'completed'); assert.equal(thousand.combatants.filter(unit => unit.side === 'enemy').length, 1000); assert.ok(thousandMs < 10000, '1000 unit scenario exceeded 10s test budget');

// Boss phases and mixed boss + cohort bookkeeping.
let mixed = reload(engine.create(payload('boss-plus-mobs', [baseUnit('player', { controller: 'ai', hp: 1000, maxHp: 1000, attack: 35 }), baseUnit('enemy', { id: 'boss', name: 'Boss', boss: true, hp: 120, maxHp: 120, armor: 0, attackModifier: -100 }), baseUnit('enemy', { id: 'minion', name: '小兵', count: 12, hp: 10, maxHp: 10, attackModifier: -100 })])).id);
await engine.start(mixed);
while (mixed.status === 'paused' && mixed.pauseReason?.type === 'reaction_window') await engine.reaction(mixed, { choice: 'defend' });
commit(mixed);
assert.equal(mixed.combatants.filter(unit => unit.boss).length, 1);
assert.equal(mixed.combatants.filter(unit => unit.templateId === 'minion').length, 12);
assert.ok(repository.events(mixed.id).some(event => event.type === 'boss_phase_changed'));

// Strategy trigger compiler and local takeover.
const strategy = compileStrategy('优先集火 Boss，HP 低于 35% 或击杀 60% 敌人时接管，保留 25% EP。', { confirmed: true });
assert.equal(strategy.confirmed, true); assert.ok(strategy.takeoverTriggers.some(item => item.value === 35)); assert.ok(strategy.takeoverTriggers.some(item => item.value === 60));
const guerrillaStrategy = compileStrategy('先潜行接敌，采用游击队战术分割目标，逐个击破，命中后撤离。', { confirmed: true });
assert.equal(guerrillaStrategy.stealth, true);
assert.equal(guerrillaStrategy.guerrilla, true);

// QuickJS capability sandbox returns declarations only; forbidden host access is rejected.
const sandboxSource = 'api.damage(input.targets[0].id, 12, "true"); api.status(input.targets[0].id, "stunned", 1);';
const sandboxResult = await runScript(sandboxSource, { ability: { id: 'sandbox', name: '沙箱能力' }, actor: { id: 'actor' }, targets: [{ id: 'target' }] });
assert.equal(sandboxResult.effects.length, 2); assert.equal(sandboxResult.effects[0].amount, 12);
const sandboxTests = await testScript(sandboxSource, { id: 'sandbox', name: '沙箱能力' }); assert.equal(sandboxTests.passed, true);
await assert.rejects(() => runScript('fetch("https://example.com")', { ability: {}, actor: {}, targets: [] }), /禁止能力/);

// Approved scripts also execute in automatic mode; approval is keyed by source + ruleset.
let scripted = reload(engine.create(payload('script-auto', [baseUnit('player', { controller: 'ai', abilities: [{ id: 'script-hit', name: '脚本打击', type: 'true', range: 'contact', script: 'api.damage(input.targets[0].id, 200, "true");' }] }), baseUnit('enemy', { attackModifier: -100 })])).id);
await engine.start(scripted); assert.equal(scripted.status, 'awaiting_script_approval');
const approvedHash = scriptHash(scripted.combatants[0].abilities.find(item => item.id === 'script-hit').script);
repository.approveScript(approvedHash, scripted.rulesetVersion, { test: true }); scripted.status = 'ready'; scripted.pauseReason = null;
await engine.start(scripted); commit(scripted); assert.equal(scripted.status, 'completed'); assert.ok(repository.events(scripted.id).some(event => event.type === 'script_action_resolved'));

// Every ledger is a valid hash chain and replay state retains RNG position.
for (const state of [first, second, manual, tactical, movementPool, counterattack, revealAfterMove, slots, auditory, intel, meleeReveal, hive, mass, thousand, mixed, scripted]) {
    const events = repository.events(state.id); assert.ok(events.length > 0);
    for (let index = 1; index < events.length; index += 1) assert.equal(events[index].previousHash, events[index - 1].hash);
    assert.ok(state.rng.index > 0);
}

console.log(JSON.stringify({ ok: true, deterministicHash: first.lastEventHash, massMs: Math.round(massMs), massEvents: repository.events(mass.id).length, thousandMs: Math.round(thousandMs), thousandEvents: repository.events(thousand.id).length, mixedRounds: mixed.round, mixedEvents: repository.events(mixed.id).length }, null, 2));
