const DEFAULT_TRIGGERS = [{ field: 'playerHpPercent', operator: '<=', value: 50 }, { field: 'enemyDefeatedPercent', operator: '>=', value: 50 }];

export function compileStrategy(text = '', input = {}) {
    const source = String(text).trim();
    const lower = source.toLowerCase();
    const numberAfter = pattern => Number(source.match(pattern)?.[1]);
    const triggers = [];
    const hp = numberAfter(/(?:血量|hp)[^\d]{0,8}(\d{1,3})\s*%/i);
    const ep = numberAfter(/(?:能量|ep)[^\d]{0,8}(\d{1,3})\s*%/i);
    const kills = numberAfter(/(?:击杀|敌人|数量)[^\d]{0,10}(\d{1,3})\s*%/i);
    if (Number.isFinite(hp)) triggers.push({ field: 'playerHpPercent', operator: '<=', value: hp });
    if (Number.isFinite(ep)) triggers.push({ field: 'playerEpPercent', operator: '<=', value: ep });
    if (Number.isFinite(kills)) triggers.push({ field: 'enemyDefeatedPercent', operator: '>=', value: kills });
    if (/队友.*(?:倒下|倒地|失能)/.test(source)) triggers.push({ field: 'allyDying', operator: '==', value: true });
    if (/(?:boss|首领).*(?:阶段|变身)/i.test(source)) triggers.push({ field: 'bossPhaseChanged', operator: '==', value: true });
    const locallyCompiled = {
        source,
        confirmed: Boolean(input.confirmed),
        priorities: lower.includes('boss') || source.includes('首领') ? ['boss', 'weakest', 'nearest'] : source.includes('残血') ? ['weakest', 'boss', 'nearest'] : ['nearest', 'weakest', 'boss'],
        preserveEpPercent: Number.isFinite(ep) ? ep : 20,
        allowItems: !/(?:不用|禁止).*(?:道具|物品)/.test(source),
        allowFriendlyFire: /允许友伤/.test(source),
        // “拉扯/风筝/边打边退” is the player-facing name for the same
        // local retreat policy.  Keep the persisted field as `retreat` so
        // older strategy payloads remain compatible.
        retreat: /撤退|逃跑|拉扯|风筝|保持距离|边打边退|游击|分割|逐个击破/.test(source),
        stealth: /潜行|隐蔽|隐身|偷袭|游击|分割/.test(source),
        guerrilla: /游击|分割|切割|诱导|逐个击破|避免主群/.test(source),
        reactionPolicy: /保留反应|不反击/.test(source) ? 'conserve' : 'auto',
        takeoverTriggers: Array.isArray(input.takeoverTriggers) && input.takeoverTriggers.length ? input.takeoverTriggers : triggers.length ? triggers : DEFAULT_TRIGGERS,
        compiledAt: new Date().toISOString(),
    };
    const ai = input.compiled && typeof input.compiled === 'object' ? input.compiled : {};
    const validPriorities = ['nearest', 'weakest', 'boss'];
    if (Array.isArray(ai.priorities)) locallyCompiled.priorities = [...new Set(ai.priorities.filter(item => validPriorities.includes(item)))].concat(validPriorities).slice(0, 3);
    if (Number.isFinite(Number(ai.preserveEpPercent))) locallyCompiled.preserveEpPercent = Math.max(0, Math.min(100, Number(ai.preserveEpPercent)));
    for (const key of ['allowItems', 'allowFriendlyFire', 'retreat', 'stealth', 'guerrilla']) if (typeof ai[key] === 'boolean') locallyCompiled[key] = ai[key];
    if (['auto', 'conserve'].includes(ai.reactionPolicy)) locallyCompiled.reactionPolicy = ai.reactionPolicy;
    if (Array.isArray(ai.takeoverTriggers)) {
        const fields = new Set(['playerHpPercent', 'playerEpPercent', 'enemyDefeatedPercent', 'allyDying', 'bossPhaseChanged', 'round', 'noLegalAction']);
        const operators = new Set(['<=', '>=', '==', '!=']);
        const safe = ai.takeoverTriggers.filter(item => item && fields.has(item.field) && operators.has(item.operator) && (typeof item.value === 'boolean' || Number.isFinite(Number(item.value)))).map(item => ({ field: item.field, operator: item.operator, value: typeof item.value === 'boolean' ? item.value : Number(item.value) }));
        if (safe.length) locallyCompiled.takeoverTriggers = safe;
    }
    locallyCompiled.compiler = Object.keys(ai).length ? 'combat-ai+local-validator' : 'local-parser';
    return locallyCompiled;
}

export function evaluateTriggers(state) {
    const players = state.combatants.filter(unit => unit.side === 'player');
    const enemies = state.combatants.filter(unit => unit.side === 'enemy');
    const initialEnemies = state.initialCounts?.enemy || enemies.length;
    const values = {
        playerHpPercent: Math.min(...players.map(unit => unit.maxHp ? unit.hp / unit.maxHp * 100 : 0)),
        playerEpPercent: Math.min(...players.map(unit => unit.maxEp ? unit.ep / unit.maxEp * 100 : 100)),
        enemyDefeatedPercent: initialEnemies ? enemies.filter(unit => unit.state !== 'active').length / initialEnemies * 100 : 100,
        allyDying: players.some(unit => unit.state === 'dying' || unit.state === 'dead'),
        bossPhaseChanged: Boolean(state.flags?.bossPhaseChanged),
        round: state.round,
        noLegalAction: Boolean(state.flags?.noLegalAction),
    };
    const compare = (left, operator, right) => operator === '<=' ? left <= right : operator === '>=' ? left >= right : operator === '!=' ? left !== right : left === right;
    return (state.strategy?.takeoverTriggers || []).filter(trigger => compare(values[trigger.field], trigger.operator, trigger.value)).map(trigger => ({ ...trigger, actual: values[trigger.field] }));
}
