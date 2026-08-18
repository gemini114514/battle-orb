// 本地脚本库：已由本地沙箱实现、可直接复用的技能效果模板。
// 战斗建模 AI 对匹配的效果只需写 `"scriptLibrary":"<id>"`（可选 `"libraryParams":{...}`），
// 本地在进入沙箱前按参数实例化 script。由于实例化后的源码稳定，相同参数跨战斗哈希一致，
// 一经批准即可命中持久化审批缓存，避免每次战斗重复创建/审批脚本。
//
// 参数占位符写法：源码中使用 {{paramName}}，实例化时用 libraryParams 覆盖（默认取 params）。

export const SCRIPT_LIBRARY = Object.freeze([
    {
        id: 'volley',
        name: '连射/连击 N 发',
        description: '固定多发攻击：每次激活无条件发射恰好 N 发独立 api.attack；第 1 发打所选主目标（targets[0]），后续每一发优先改打另一存活敌人（api.state().enemies 里 hp>0 且 id 不同），无其它存活敌人时才连击同一目标。每一发都走独立权威检定。',
        params: { shots: 2 },
        script: `const state = api.state(); const primary = (state.targets || [])[0]; if (!primary) { api.log('没有可攻击目标'); } else { api.attack(primary.id); for (let i = 1; i < {{shots}}; i += 1) { const alt = state.enemies.find(u => u.hp > 0 && u.id !== primary.id); api.attack((alt || primary).id); } }`,
    },
    {
        id: 'guard-stance',
        name: '防御架势',
        description: '给自己或指定友方附加防御架势：被近战攻击时防御 DC 提升，持续若干回合。',
        params: { turns: 3, defenseBonus: 6, target: 'self' },
        script: `const actor = api.state().actor; const target = {{target}} === 'self' ? actor : (api.state().targets[0] || actor); api.status(target.id, { id: 'guard-stance', name: '防御架势', defenseBonus: {{defenseBonus}}, vsMelee: true }, {{turns}}); api.log('防御架势展开');`,
    },
    {
        id: 'heal',
        name: '治疗/急救',
        description: '治疗指定友方并附加“伤势稳定”状态（持续若干回合）。',
        params: { amount: 40, turns: 2 },
        script: `const target = api.state().targets[0] || api.state().actor; api.heal(target.id, {{amount}}); api.status(target.id, { id: 'stabilized', name: '伤势稳定' }, {{turns}}); api.log('完成治疗');`,
    },
    {
        id: 'dot-poison',
        name: '持续伤害（DoT/中毒）',
        description: '对目标附加持续若干回合的每回合伤害（damagePerRound 状态）。',
        params: { amount: 3, turns: 3 },
        script: `const target = api.state().targets[0]; if (target) { api.status(target.id, { id: 'poison', name: '中毒', damagePerRound: {{amount}} }, {{turns}}); api.log('附加持续伤害'); }`,
    },
    {
        id: 'on-kill-siphon',
        name: '击杀回复（被动 on_kill）',
        description: '被动技能：本单位击杀任意敌人后立即恢复自身生命。',
        params: { amount: 10 },
        script: `const a = api.state().actor; api.heal(a.id, {{amount}}); api.log('击杀回复生命');`,
    },
    {
        id: 'battle-cry',
        name: '属性增益（buff）',
        description: '给自己或指定目标附加某项属性加成（attack/attackModifier/defenseDC/armor 等），持续若干回合后自动还原。',
        params: { turns: 3, field: 'attack', amount: 5, target: 'self' },
        script: `const actor = api.state().actor; const target = {{target}} === 'self' ? actor : (api.state().targets[0] || actor); api.modify(target.id, '{{field}}', {{amount}}, { rounds: {{turns}} }); api.log('属性增益生效');`,
    },
    {
        id: 'pushback',
        name: '击退/位移',
        description: '推开目标一段距离（可选先发一次攻击，再击退）。',
        params: { dx: 1.5, amount: 0 },
        script: `const target = api.state().targets[0]; if (target) { if ({{amount}} > 0) { api.attack(target.id); } api.push(target.id, {{dx}}, 0); api.log('击退目标'); }`,
    },
]);

export function materializeScriptLibrary(ability) {
    const id = String(ability?.scriptLibrary || '');
    if (!id) return ability;
    const entry = SCRIPT_LIBRARY.find(item => item.id === id);
    if (!entry) return ability;
    if (ability.script) return ability;
    const params = { ...(entry.params || {}), ...(ability.libraryParams || {}) };
    let source = entry.script;
    for (const [key, value] of Object.entries(params)) source = source.split(`{{${key}}}`).join(String(value));
    if (source.includes('{{')) return ability;
    return { ...ability, script: source };
}

export function scriptLibraryPromptText() {
    return SCRIPT_LIBRARY.map(entry =>
        `- ${entry.id}（${entry.name}）\n  效果：${entry.description}\n  默认参数：${JSON.stringify(entry.params)}\n  源码：${entry.script}`
    ).join('\n');
}
