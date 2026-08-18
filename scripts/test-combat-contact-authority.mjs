import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CombatEngine } from '../combat/engine.js';
import { CombatRepository } from '../combat/repository.js';
import { validateBattleDeclaration, validateCombatModel } from '../combat/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qualities = { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' };
const declaration = {
    schema: 'vibe-combat-declaration/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true, contactPairs: [['alice', 'guard']], reason: '已经对话后发生冲突',
    battlefield: { kind: '走廊', shapeHint: 'rectangle', description: '狭长走廊' },
    participants: [
        { id: 'alice', name: '艾莉丝', side: 'player', source: 'existing', reference: '主角', state: '与敌人刚刚对话，已明确看见', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '左侧' },
        { id: 'guard', name: '守卫', side: 'enemy', source: 'create', state: '与玩家对话并持械警戒', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '右侧' },
    ],
};
const unit = (id, name, side, x) => ({ id, declarationId: id, name, side, controller: side === 'player' ? 'player' : 'ai', lifeLevel: 'Ⅰ', attributeQualities: qualities, combatProvenance: { source: 'combat-ai-derived', worldLifeLevel: 'Ⅰ', lifeLevel: 'Ⅰ', attributeQualities: qualities, formulaVersion: 'v3.2.6' }, assetBindings: [], hp: 40, maxHp: 40, ep: 0, maxEp: 0, attack: 8, magicAttack: 0, attackModifier: 0, defenseDC: 30, initiativeDC: 0, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x, y: 0 }, facingDegrees: side === 'player' ? 0 : 180, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: id, objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 0 }, abilities: [{ id: 'basic-attack', name: '攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] });
const model = { schema: 'vibe-combat-model/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true, contactPairs: [['alice', 'guard']], title: '接触旗标测试', battlefield: { shape: 'rectangle', widthMeters: 20, heightMeters: 10, center: { x: 0, y: 0 } }, combatants: [unit('alice', '艾莉丝', 'player', -4), unit('guard', '守卫', 'enemy', 4)], assetProfiles: [{ assetId: 'asset-test-sword', fingerprint: 'equipment:测试剑:{}', kind: 'equipment', name: '测试剑', finalAttributes: { ATK: 8 }, combat: { minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, attackStyle: 'melee' } }] };
model.combatants[0].assetBindings = ['asset-test-sword'];
assert.equal(validateBattleDeclaration(declaration, { strict: true }).ok, true);
assert.equal(validateCombatModel(model, { declaration, strict: true }).ok, true);
const repository = new CombatRepository(root);
const engine = new CombatEngine(repository);
const created = engine.create({ transient: true, mode: 'manual', encounter: model, seed: 'contact-authority-regression' });
const state = repository.get(created.id);
const persistedAlice = state.combatants.find(item => item.id === 'alice');
assert.equal(persistedAlice.declarationId, 'alice');
assert.equal(persistedAlice.lifeLevel, 'Ⅰ');
assert.deepEqual(persistedAlice.attributeQualities, qualities);
assert.deepEqual(persistedAlice.assetBindings, ['asset-test-sword']);
assert.equal(persistedAlice.combatProvenance.formulaVersion, 'v3.2.6');
await engine.start(state);
assert.equal(state.intel.knowledge.alice.guard.source, 'dialogue');
assert.equal(state.intel.knowledge.alice.guard.canTarget, true);
assert.equal(state.intel.knowledge.guard.alice.source, 'dialogue');
assert.ok(state.pendingEvents.some(event => event.type === 'contact_seeded'));
console.log(JSON.stringify({ ok: true, declarationStrict: true, modelStrict: true, aliceAwareness: state.intel.knowledge.alice.guard, guardAwareness: state.intel.knowledge.guard.alice, contactSeedEvents: state.pendingEvents.filter(event => event.type === 'contact_seeded').length }, null, 2));
