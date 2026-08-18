const quote = value => JSON.stringify(String(value ?? ''));
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;

function unitLabel(unit, units) {
    const item = units.get(String(unit));
    return item ? `${item.name || item.id}#${item.id}` : String(unit ?? 'unknown');
}

function line(parts) {
    return parts.filter(item => item !== undefined && item !== null).join(' ');
}

// This is intentionally line-oriented: it is smaller than replay JSON while
// keeping every adjudicated exchange available to the narrative model.
export function buildBattleResultDsl({ state, events, final }) {
    const units = new Map((final?.finalState?.combatants || state.combatants || []).map(unit => [String(unit.id), unit]));
    const output = [
        'BATTLE_RESULT_DSL v1',
        line(['META', `battle=${quote(state.id)}`, `title=${quote(state.title || '')}`, `rounds=${number(final?.rounds ?? state.round) ?? 0}`, `winner=${quote(final?.winner || 'undecided')}`]),
    ];
    for (const unit of units.values()) output.push(line(['UNIT', `id=${quote(unit.id)}`, `name=${quote(unit.name || unit.id)}`, `side=${quote(unit.side)}`, `count=${number(unit.count) ?? 1}`]));

    let currentRound = null;
    for (const event of events || []) {
        const payload = event.payload || {};
        if (event.round !== currentRound && event.round !== undefined) {
            currentRound = event.round;
            output.push(line(['ROUND', `n=${currentRound}`]));
        }
        const common = [`seq=${event.sequence}`, `r=${event.round ?? 0}`];
        if (event.type === 'attack_check') {
            const result = payload.result || payload;
            const applied = result.applied || payload.applied || {};
            const damage = result.damage || payload.damage || {};
            output.push(line(['ENGAGE', ...common,
                `actor=${quote(unitLabel(payload.actorId, units))}`,
                `target=${quote(unitLabel(payload.targetId, units))}`,
                `ability=${quote(payload.abilityId || 'attack')}`,
                `distance=${number(payload.attackBasis?.edgeDistanceMeters) ?? 'unknown'}`,
                `roll=${number(payload.selected) ?? 'unknown'}`,
                `total=${number(payload.total) ?? 'unknown'}`,
                `dc=${number(payload.defenseDC) ?? 'unknown'}`,
                `outcome=${quote(payload.outcome || 'unknown')}`,
                `damage=${number(damage.final) ?? 0}`,
                `hp=${number(applied.before?.hp) ?? 'unknown'}>${number(applied.after?.hp) ?? 'unknown'}`,
                `state=${quote(applied.before?.state || '')}>${quote(applied.after?.state || '')}`,
                `counterattack=${Boolean(payload.counterattack)}`
            ]));
            if (applied.after?.state === 'dying' || applied.after?.state === 'dead') output.push(line(['KILL', ...common, `killer=${quote(unitLabel(payload.actorId, units))}`, `target=${quote(unitLabel(payload.targetId, units))}`, `kind=${quote(applied.after.state === 'dead' ? 'dead' : 'downed')}`, `state=${quote(applied.after.state)}`, `hp=${number(applied.after.hp) ?? 0}`]));
        } else if (event.type === 'counterattack_triggered') {
            output.push(line(['COUNTER', ...common, `actor=${quote(unitLabel(payload.actorId, units))}`, `target=${quote(unitLabel(payload.targetId, units))}`, `ability=${quote(payload.abilityId || 'basic-attack')}`]));
        } else if (event.type === 'unit_state_changed') {
            output.push(line(['STATE', ...common, `unit=${quote(unitLabel(payload.unitId, units))}`, `from=${quote(payload.from || '')}`, `to=${quote(payload.to || '')}`]));
        } else if (event.type === 'unit_moved') {
            output.push(line(['MOVE', ...common, `unit=${quote(unitLabel(payload.actorId, units))}`, `distance=${number(payload.distanceMeters) ?? 0}`, `from=${quote(JSON.stringify(payload.from || {}))}`, `to=${quote(JSON.stringify(payload.to || {}))}`, `source=${quote(payload.source || '')}`]));
        } else if (event.type === 'boss_phase_changed') {
            output.push(line(['PHASE', ...common, `unit=${quote(unitLabel(payload.unitId, units))}`, `threshold=${number(payload.threshold) ?? 'unknown'}`, `hpPercent=${number(payload.hpPercent) ?? 'unknown'}`]));
        } else if (event.type === 'maneuver_resolved' || event.type === 'withdrawal_resolved') {
            output.push(line(['MANEUVER', ...common, `unit=${quote(unitLabel(payload.actorId, units))}`, `type=${quote(payload.maneuver || event.type)}`, `result=${quote(payload.success === undefined ? 'resolved' : payload.success ? 'success' : 'failure')}`, `distance=${number(payload.distanceMeters) ?? 0}`]));
        }
    }
    for (const casualty of final?.casualties || []) output.push(line(['CASUALTY', `unit=${quote(unitLabel(casualty.id, units))}`, `side=${quote(casualty.side)}`, `state=${quote(casualty.state)}`]));
    output.push(line(['END', `winner=${quote(final?.winner || 'undecided')}`, `rounds=${number(final?.rounds ?? state.round) ?? 0}`]));
    return output.join('\n');
}

// 回写主 AI 的 MVU 指令里必须更新击杀数量：按单位生命层级（lifeLevel，缺省用
// worldLifeLevel）把阵亡敌方累计进后台 `任务.击杀.{层级}` 字典，值 = 原值 + 本场击杀。
// 与卡内【Patch计数】规则一致：只改对应层级局部路径，不重写整个列表。
export function buildKillCountPatches(finalCombatants, worldLifeLevel = '', currentKills = {}) {
    const killsByLayer = {};
    for (const unit of finalCombatants || []) {
        if (unit.side !== 'enemy' || unit.state === 'active') continue;
        const layer = String(unit.lifeLevel || worldLifeLevel || 'Ⅰ');
        killsByLayer[layer] = (killsByLayer[layer] || 0) + Math.max(1, Number(unit.count) || 1);
    }
    return Object.keys(killsByLayer).map(layer => ({
        op: 'replace',
        path: `/stat_data/任务/击杀/${layer}`,
        value: (Number(currentKills[layer]) || 0) + killsByLayer[layer],
    }));
}
