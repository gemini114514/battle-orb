import assert from 'node:assert/strict';
import { CombatEngine } from '../combat/engine.js';
import { BrowserCombatRepository } from '../combat/browser-repository.js';
import { materializeScriptLibrary } from '../combat/script-library.js';
import { runScript } from '../combat/sandbox.js';

let passed = 0;
const check = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  PASS ${name}`); }
    catch (error) { console.error(`  FAIL ${name}: ${error.message}`); process.exitCode = 1; }
};

const mk = (id, name, side, controller = 'ai', x = 0, extra = {}) => ({
    id, name, side, controller, count: 1, hp: 20, maxHp: 20, thp: 0, ep: 8, maxEp: 8, attack: 5, attackModifier: 1, defenseDC: 10, initiativeDC: 0,
    position: { x, y: 0 }, visionMeters: 12, attributes: { strengthModifier: 1, dexterityModifier: 1, constitutionModifier: 1, spiritModifier: 3, charismaModifier: 1 },
    intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 5, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 6, attackNoiseMeters: 10 },
    tacticalProfile: { role: 'melee', preferredRangeMeters: 1.5, priorities: ['nearest'], mobility: 'normal', threatLevel: 'low' },
    abilities: [{ id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }],
    ...extra,
});

const encounter = (extraUnits = []) => ({
    schema: 'vibe-combat-model/v3', title: 't', location: 'l',
    battlefield: { shape: 'rectangle', widthMeters: 30, heightMeters: 6, center: { x: 0, y: 0 } },
    zones: [{ id: 'field', name: 'f', adjacent: [], capacity: 999 }],
    combatants: [mk('alice', '艾莉丝', 'player', 'player', -9), mk('zombie', '死体', 'enemy', 'ai', 10), ...extraUnits],
});

console.log('support-ability-api tests');

await check('materialize logic-deflection produces api.check script', () => {
    const ability = materializeScriptLibrary({ id: 'deflect', scriptLibrary: 'logic-deflection', libraryParams: { dc: 50, defenseBonus: 25, resistanceBonus: 15, lockImmunity: 'D', turns: 4, target: 'self' } });
    assert.ok(ability.script.includes('api.check'), 'script should call api.check');
    assert.ok(ability.script.includes('lockImmunity'), 'script should set lockImmunity');
});

await check('runScript logic-deflection: success path applies status effects', async () => {
    const ability = materializeScriptLibrary({ id: 'deflect', name: '逻辑偏转', scriptLibrary: 'logic-deflection', libraryParams: { dc: 50, defenseBonus: 25, resistanceBonus: 15, lockImmunity: 'D', turns: 4, target: 'self' } });
    const actor = mk('alice', '艾莉丝', 'player', 'player', -9);
    let status = null;
    for (let seed = 0; seed < 20 && !status; seed += 1) {
        const out = await runScript(ability.script, { ability, rng: { seed: `deflect-test-${seed}`, count: 0 }, actor, targets: [actor], units: [actor, mk('zombie', '死体', 'enemy', 'ai', 10)], battlefield: { shape: 'rectangle', widthMeters: 30, heightMeters: 6 }, round: 1 });
        status = out.effects.find(effect => effect.type === 'status');
        if (status) {
            assert.equal(status.status.defenseBonus, 25);
            assert.equal(status.status.resistanceBonus, 15);
            assert.equal(status.status.lockImmunity, 'D');
            assert.equal(status.status.duration, 4);
        }
    }
    assert.ok(status, 'at least one seed should pass the check and emit a status effect');
});

await check('api.check is deterministic for the same seed', async () => {
    const script = `api.check({ dc: 70, modifier: 2, label: '精神判定' });`;
    const a = await runScript(script, { rng: { seed: 'chk', count: 0 }, actor: mk('alice', '艾莉丝', 'player', 'player'), targets: [], units: [] });
    const b = await runScript(script, { rng: { seed: 'chk', count: 0 }, actor: mk('alice', '艾莉丝', 'player', 'player'), targets: [], units: [] });
    const msgOf = out => out.effects.find(effect => effect.type === 'log')?.message;
    assert.equal(msgOf(a), msgOf(b), 'same seed should produce same check result');
});

await check('resistance check: resistanceBonus + spiritModifier grants save', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-resist' }));
    const battle = engine.create({ seed: 'resist1', mode: 'auto', transient: true, encounter: encounter() });
    const state = engine.repository.get(battle.id);
    const target = state.combatants.find(unit => unit.id === 'alice');
    target.attributes = { spiritModifier: 5 };
    target.statuses = [{ id: 'logic-deflection', name: '逻辑偏转', resistanceBonus: 15, duration: 4 }];
    let resolved = false;
    for (let i = 0; i < 1000 && !resolved; i += 1) resolved = engine.resistanceCheck(state, target, 60);
    assert.ok(resolved, 'with +15 resistance and +5 spirit, DC 60 should eventually pass');
});

await check('resistance check: no bonus rarely passes high DC', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-resist2' }));
    const battle = engine.create({ seed: 'resist2', mode: 'auto', transient: true, encounter: encounter() });
    const state = engine.repository.get(battle.id);
    const target = state.combatants.find(unit => unit.id === 'alice');
    target.attributes = { spiritModifier: 0 };
    target.statuses = [];
    let passed = 0;
    for (let i = 0; i < 200; i += 1) if (engine.resistanceCheck(state, target, 95)) passed += 1;
    assert.ok(passed < 50, `DC 95 with no modifier should rarely pass (got ${passed}/200)`);
});

await check('status effect with saveDC: resisted when save succeeds', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-savedc' }));
    const battle = engine.create({ seed: 'savedc1', mode: 'auto', transient: true, encounter: encounter() });
    const state = engine.repository.get(battle.id);
    const target = state.combatants.find(unit => unit.id === 'alice');
    target.attributes = { spiritModifier: 30 };
    const before = target.statuses.length;
    await engine.applyEffects(state, state.combatants.find(unit => unit.id === 'zombie'), [{ type: 'status', targetId: 'alice', status: { id: 'poison', name: '中毒', saveDC: 1, damagePerRound: 5, duration: 2 } }]);
    assert.equal(target.statuses.length, before, 'DC 1 save should always succeed -> status resisted');
});

await check('lock immunity: D-grade lock resisted by lockImmunity D', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-lock' }));
    const battle = engine.create({ seed: 'lock1', mode: 'auto', transient: true, encounter: encounter() });
    const state = engine.repository.get(battle.id);
    const target = state.combatants.find(unit => unit.id === 'alice');
    target.statuses.push({ id: 'logic-deflection', name: '逻辑偏转', lockImmunity: 'D', duration: 4 });
    await engine.applyEffects(state, state.combatants.find(unit => unit.id === 'zombie'), [{ type: 'lock', targetId: 'alice', grade: 'D', duration: 1 }]);
    assert.ok(!target.statuses.some(status => status.id === 'locked'), 'D-grade lock should be resisted');
});

await check('lock immunity: C-grade lock NOT resisted by lockImmunity D', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-lock2' }));
    const battle = engine.create({ seed: 'lock2', mode: 'auto', transient: true, encounter: encounter() });
    const state = engine.repository.get(battle.id);
    const target = state.combatants.find(unit => unit.id === 'alice');
    target.statuses.push({ id: 'logic-deflection', name: '逻辑偏转', lockImmunity: 'D', duration: 4 });
    await engine.applyEffects(state, state.combatants.find(unit => unit.id === 'zombie'), [{ type: 'lock', targetId: 'alice', grade: 'C', duration: 1 }]);
    assert.ok(target.statuses.some(status => status.id === 'locked' && status.lockGrade === 'C'), 'C-grade lock should still apply');
});

await check('locked target is auto-hit and lock consumed', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-lock3' }));
    const battle = engine.create({ seed: 'lock3', mode: 'auto', transient: true, encounter: encounter() });
    const state = engine.repository.get(battle.id);
    const alice = state.combatants.find(unit => unit.id === 'alice');
    const zombie = state.combatants.find(unit => unit.id === 'zombie');
    state.intel.knowledge ||= {};
    state.intel.knowledge[zombie.id] ||= {};
    state.intel.knowledge[zombie.id][alice.id] = { source: 'visual', awareness: 'tracking', canTarget: true, position: { ...alice.position }, round: 1, reason: 'test' };
    zombie.position = { x: -8, y: 0 };
    state.engagements = {};
    alice.statuses.push({ id: 'locked', name: '必中锁定', lockGrade: 'D', duration: 1 });
    const hpBefore = alice.hp;
    await engine.resolveAttack(state, zombie, [alice], zombie.abilities[0], { ignoreEngagement: true });
    assert.ok(alice.hp < hpBefore, 'locked target should take damage');
    assert.ok(!alice.statuses.some(status => status.id === 'locked'), 'lock should be consumed after attack');
});

await check('neutral never manual-pauses (round advances past neutral with controller=player)', async () => {
    const engine = new CombatEngine(new BrowserCombatRepository({ chatId: 'chat-neutral' }));
    const battle = engine.create({ seed: 'neutral1', mode: 'manual', encounter: encounter([mk('shizuka', '静香', 'neutral', 'player', -11)]) });
    const state = engine.repository.get(battle.id);
    engine.repository.autoApprove = true;
    await engine.start(state);
    assert.equal(state.pauseReason?.type, 'manual_turn');
    assert.equal(state.activeUnitId, 'alice');
    await engine.command(state, { type: 'wait', actorId: state.activeUnitId });
    assert.equal(state.round, 2, 'round should advance past the neutral unit');
    assert.equal(state.activeUnitId, 'alice', 'next manual turn should be the player again');
});

await check('cache key is scoped by chatId', () => {
    const repoA = new BrowserCombatRepository({ chatId: 'save-1' });
    const repoB = new BrowserCombatRepository({ chatId: 'save-2' });
    assert.notEqual(repoA.storageKey, repoB.storageKey);
    assert.ok(repoA.storageKey.includes('save-1'));
    assert.ok(repoB.storageKey.includes('save-2'));
    assert.ok(repoA.storageKey.startsWith('battle-orb.approved-scripts'));
});

await check('cache default key (no chatId) preserved for compat', () => {
    const repo = new BrowserCombatRepository();
    assert.equal(repo.storageKey, 'battle-orb.approved-scripts');
});

console.log(`\nsupport-ability-api: ${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
