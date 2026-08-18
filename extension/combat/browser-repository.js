import { deepClone } from './util.js';

const APPROVED_KEY = 'battle-orb.approved-scripts';
const APPROVED_LIMIT = 500;

export class BrowserCombatRepository {
    constructor() {
        this.states = new Map();
        this.ledger = new Map();
        this.assets = new Map();
        this.approved = new Set();
        this.autoApprove = false;
        // 持久化脚本审批缓存：同一规则版本 + 同一源码哈希跨战斗/跨刷新复用，避免每次战斗重复创建脚本。
        try {
            const stored = JSON.parse(localStorage.getItem(APPROVED_KEY) || '[]');
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
        const pending = Array.isArray(state.pendingEvents) ? state.pendingEvents.splice(0) : [];
        for (const event of pending) this.appendEvent(state.id, event);
        this.save(state);
        return this.publicSnapshot(state);
    }

    isScriptApproved(hash, rulesetVersion) { return this.approved.has(`${rulesetVersion}:${hash}`); }

    approveScript(hash, rulesetVersion) {
        this.approved.add(`${rulesetVersion}:${hash}`);
        try {
            localStorage.setItem(APPROVED_KEY, JSON.stringify([...this.approved].slice(-APPROVED_LIMIT)));
        } catch { /* 忽略持久化写入失败 */ }
    }

    publicSnapshot(state) { return deepClone(state); }
}
