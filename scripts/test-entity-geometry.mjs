import assert from 'node:assert/strict';
import { entityRadiusMeters, normalizeEncounter } from '../combat/rules.js';

const qualities = { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' };
const ability = { id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false };
const base = { hp: 20, maxHp: 20, ep: 0, maxEp: 0, attack: 10, magicAttack: 0, attackModifier: 0, defenseDC: 50, initiativeDC: 0, armor: 0, resistance: 0, speedMeters: 6, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, lifeLevel: 'Ⅰ', attributeQualities: qualities, combatProvenance: { source: 'combat-ai-derived', worldLifeLevel: 'Ⅰ', lifeLevel: 'Ⅰ', attributeQualities: qualities, formulaVersion: 'v3.2.6' }, abilities: [ability] };

assert.equal(entityRadiusMeters({ name: '普通人类', species: 'human', side: 'enemy', radiusMeters: 3 }), 3);
assert.equal(entityRadiusMeters({ name: '巨型兽', sizeClass: 'large', side: 'enemy', radiusMeters: 3 }), 3);
const encounter = normalizeEncounter({ title: '实体几何回归', battlefield: { shape: 'rectangle', widthMeters: 30, heightMeters: 20, center: { x: 0, y: 0 } }, combatants: [
    { ...base, id: 'player', name: '主角', side: 'player', radiusMeters: 3 },
    { ...base, id: 'human', name: '普通人类', species: 'human', side: 'enemy', radiusMeters: 3, position: { x: 5, y: 0 } },
    { ...base, id: 'beast', name: '巨型兽', side: 'enemy', sizeClass: 'large', radiusMeters: 3, position: { x: 10, y: 0 } },
] });
const player = encounter.combatants.find(unit => unit.id === 'player');
const human = encounter.combatants.find(unit => unit.id === 'human');
const beast = encounter.combatants.find(unit => unit.id === 'beast');
assert.equal(player.radiusMeters, 3);
assert.equal(human.radiusMeters, 3);
assert.equal(beast.radiusMeters, 3);
assert.equal(human.defenseDC, 50);
console.log(JSON.stringify({ ok: true, radii: { player: player.radiusMeters, human: human.radiusMeters, beast: beast.radiusMeters }, preservedDefenseDC: human.defenseDC }, null, 2));
