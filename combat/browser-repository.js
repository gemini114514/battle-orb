import { deepClone } from './util.js';

export class BrowserCombatRepository {
    constructor() {
        this.states = new Map();
        this.ledger = new Map();
        this.assets = new Map();
        this.approved = new Set();
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

    approveScript(hash, rulesetVersion) { this.approved.add(`${rulesetVersion}:${hash}`); }

    publicSnapshot(state) { return deepClone(state); }
}
