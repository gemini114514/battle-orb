import { deepClone } from './util.js';

const APPROVED_KEY = 'battle-orb.approved-scripts';
const APPROVED_LIMIT = 500;

const scopedKey = (base, chatId) => {
    const scope = String(chatId || '').trim();
    return scope ? `${base}.${scope}` : base;
};

export class BrowserCombatRepository {
    // 脚本审批缓存按酒馆聊天/存档编号隔离：同一源码哈希 + 规则版本，只在同一个
    // chatId 内跨战斗/跨刷新复用，避免不同存档之间的脚本审批互相污染。
    constructor(options = {}) {
        this.states = new Map();
        this.ledger = new Map();
        this.assets = new Map();
        this.approved = new Set();
        this.autoApprove = false;
        this.storageKey = scopedKey(APPROVED_KEY, options.chatId);
        // 持久化脚本审批缓存：同一规则版本 + 同一源码哈希跨战斗/跨刷新复用，避免每次战斗重复创建脚本。
        try {
            const stored = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
            if (Array.isArray(stored)) for (const key of stored) this.approved.add(String(key));
        } catch { /* 忽略持久化缓存读取失败 */ }
    }

    create(state) {
        this.states.set(state.id, state);
        this.ledger.set(state.id, []);
    }

    get(id) { return this.states.get(id) || null; }

    save(state) { this.states.set(state.id, state); }

    saveAssetProfile(profile) { if (profile?.assetId) this.assets.set(profile.assetId, deepClone(profile)); }

    assetProfile(id) { return this.assets.get(id) || null; }

    appendEvent(id, event) {
        const list = this.ledger.get(id) || [];
        list.push(deepClone(event));
        this.ledger.set(id, list);
    }

    events(id) { return deepClone(this.ledger.get(id) || []); }

    commit(state) {
        const benchmark = state?.__combatBenchmark;
        const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const eventStartedAt = benchmark ? nowMs() : 0;
        const pending = Array.isArray(state.pendingEvents) ? state.pendingEvents.splice(0) : [];
        for (const event of pending) this.appendEvent(state.id, event);
        if (benchmark) benchmark.spans['persist.events'] = { totalMs: nowMs() - eventStartedAt, count: pending.length, maxMs: nowMs() - eventStartedAt };
        const stateStartedAt = benchmark ? nowMs() : 0;
        this.save(state);
        if (benchmark) benchmark.spans['persist.state'] = { totalMs: nowMs() - stateStartedAt, count: 1, maxMs: nowMs() - stateStartedAt };
        const publicStartedAt = benchmark ? nowMs() : 0;
        const snapshot = this.publicSnapshot(state);
        if (benchmark) benchmark.spans['response.public-state'] = { totalMs: nowMs() - publicStartedAt, count: 1, maxMs: nowMs() - publicStartedAt };
        return snapshot;
    }

    isScriptApproved(hash, rulesetVersion) { return this.approved.has(`${rulesetVersion}:${hash}`); }

    approveScript(hash, rulesetVersion) {
        this.approved.add(`${rulesetVersion}:${hash}`);
        try {
            localStorage.setItem(this.storageKey, JSON.stringify([...this.approved].slice(-APPROVED_LIMIT)));
        } catch { /* 忽略持久化写入失败 */ }
    }

    publicSnapshot(state) { return deepClone(state); }
}
