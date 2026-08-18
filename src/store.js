const STORAGE_KEY = 'battle-orb:v1';
const STORAGE_COMPACT_SNAPSHOT_LIMIT = 12;
const STAT_ROOT_KEYS = ['世界', '任务', '主角', '资产', '系统状态', '关系列表', '传闻', '商城', '设置', '系统配置'];

const defaults = {
    settings: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: '',
        temperature: 0.9,
        maxTokens: 32768,
        userName: '战斗者',
        persona: '',
        activeUserProfileId: null,
        activeConnectionId: null,
        aiAssignments: {
            storyConnectionId: null,
            combatConnectionId: null,
            shopConnectionId: null,
        },
        activePresetId: null,
        promptOverrides: {},
        // Prompt Laboratory module overrides are deliberately separate from
        // the legacy single-system override.  Each mode can enable/disable or
        // replace the preset, rules, work, and dynamic modules independently.
        promptModules: {},
        uiScale: 1,
    },
    connections: [],
    activeSessionId: null,
    sessions: [],
};

function clone(value) {
    return structuredClone(value);
}

function isQuotaError(error) {
    return error?.name === 'QuotaExceededError' || /quota|storage.*exceed/i.test(String(error?.message || error));
}

function compactPromptTrace(trace) {
    if (!trace || typeof trace !== 'object') return trace;
    const messages = Array.isArray(trace.messages) ? trace.messages : [];
    const bytes = messages.reduce((total, message) => total + String(message?.content || '').length, 0);
    return {
        sentAt: trace.sentAt || null,
        model: trace.model || null,
        protocol: trace.protocol || null,
        preset: trace.preset || null,
        activeWorldbookEntries: Array.isArray(trace.activeWorldbookEntries) ? trace.activeWorldbookEntries : [],
        compacted: true,
        messageCount: messages.length,
        contentBytes: bytes,
        // Full request/response pairs remain in the IndexedDB black-box. The
        // localStorage copy only needs enough metadata for the read-only UI to
        // explain why the old trace body is unavailable after a quota fallback.
        messages: [],
    };
}

function compactMessageForStorage(message) {
    const output = clone(message || {});
    if (output.promptTrace) output.promptTrace = compactPromptTrace(output.promptTrace);
    // Swipes duplicate complete model responses. Keep the selected response;
    // the original generation is already retained in the black-box ledger.
    if (Array.isArray(output.swipes) && output.swipes.length > 1) {
        const selected = output.swipes[Number(output.swipeIndex) || 0] ?? output.content ?? '';
        output.swipes = [selected]; output.swipeIndex = 0;
    }
    return output;
}

function compactSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length <= STORAGE_COMPACT_SNAPSHOT_LIMIT) return snapshots;
    return [snapshots[0], ...snapshots.slice(-(STORAGE_COMPACT_SNAPSHOT_LIMIT - 1))];
}

function compactBranchForStorage(branch) {
    const output = clone(branch || {});
    output.messages = (output.messages || []).map(compactMessageForStorage);
    output.variableSnapshots = compactSnapshots(output.variableSnapshots || []);
    return output;
}

function compactStoreForStorage(data, { emergency = false } = {}) {
    const output = clone(data);
    output.sessions = (output.sessions || []).map(session => {
        const compact = { ...session };
        compact.messages = (session.messages || []).map(compactMessageForStorage);
        compact.variableSnapshots = compactSnapshots(session.variableSnapshots || []);
        compact.storyBranches = (session.storyBranches || []).map(branch => compactBranchForStorage(branch));
        if (emergency && compact.storyBranches.length > 1) {
            const activeId = session.activeStoryBranchId;
            compact.storyBranches = compact.storyBranches.filter(branch => branch.id === activeId || branch.id === compact.storyBranches[0]?.id);
        }
        return compact;
    });
    return output;
}

function mergeDeep(target, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return clone(source);
    const output = target && typeof target === 'object' && !Array.isArray(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(source)) output[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeDeep(output[key], value) : clone(value);
    return output;
}

function normalizeAffectionMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([name, score]) => [name, Number(score) || 0]));
}

export function normalizeRelationships(statData) {
    if (!statData || typeof statData !== 'object') return statData;
    const stat = statData;
    stat['主角'] = stat['主角'] && typeof stat['主角'] === 'object' ? stat['主角'] : {};
    stat['主角']['好感度关系'] = normalizeAffectionMap(stat['主角']['好感度关系']);
    stat['关系列表'] = stat['关系列表'] && typeof stat['关系列表'] === 'object' ? stat['关系列表'] : {};
    for (const npc of Object.values(stat['关系列表'])) {
        if (!npc || typeof npc !== 'object' || Array.isArray(npc)) continue;
        npc['好感度关系'] = normalizeAffectionMap(npc['好感度关系']);
        // 旧卡的数值好感度表示 NPC 对主角；保留旧字段，同时迁入有向关系表。
        if (!Object.hasOwn(npc['好感度关系'], '主角') && Number.isFinite(Number(npc['好感度'])) && Number(npc['好感度']) !== 0) npc['好感度关系']['主角'] = Number(npc['好感度']);
    }
    return stat;
}

export function getAffection(statData, sourceName, targetName) {
    if (!sourceName || !targetName || sourceName === targetName) return 0;
    const entity = sourceName === '主角' ? statData?.['主角'] : statData?.['关系列表']?.[sourceName];
    const mapped = entity?.['好感度关系']?.[targetName];
    if (mapped !== undefined) return Number(mapped) || 0;
    if (sourceName !== '主角' && targetName === '主角') return Number(entity?.['好感度']) || 0;
    return 0;
}

function migrateVariables(variables) {
    if (!variables || typeof variables !== 'object') return variables;
    const next = clone(variables);
    next.stat_data = next.stat_data && typeof next.stat_data === 'object' ? next.stat_data : {};
    for (const key of STAT_ROOT_KEYS) {
        if (next[key] === undefined) continue;
        next.stat_data[key] = mergeDeep(next.stat_data[key], next[key]);
        delete next[key];
    }
    normalizeRelationships(next.stat_data);
    return next;
}

function normalizeStoryBranch(branch, fallback = {}) {
    const now = new Date().toISOString();
    return {
        id: branch?.id || crypto.randomUUID(),
        label: String(branch?.label || fallback.label || '主线'),
        createdAt: branch?.createdAt || fallback.createdAt || now,
        updatedAt: branch?.updatedAt || now,
        parentBranchId: branch?.parentBranchId || null,
        forkKey: branch?.forkKey || null,
        forkMessageId: branch?.forkMessageId || null,
        messages: Array.isArray(branch?.messages) ? branch.messages : (fallback.messages || []),
        variables: migrateVariables(branch?.variables ?? fallback.variables ?? {}),
        variableSnapshots: (branch?.variableSnapshots ?? fallback.variableSnapshots ?? []).map(snapshot => ({ ...snapshot, variables: migrateVariables(snapshot.variables) })),
    };
}

function ensureStoryBranches(session, { hydrate = true } = {}) {
    if (!Array.isArray(session.storyBranches) || !session.storyBranches.length) {
        const main = normalizeStoryBranch(null, {
            label: '主线', createdAt: session.createdAt,
            messages: Array.isArray(session.messages) ? session.messages : [],
            variables: session.variables,
            variableSnapshots: session.variableSnapshots,
        });
        session.storyBranches = [main];
        session.activeStoryBranchId = main.id;
    } else {
        if (!session.storyBranches.some(branch => branch.id === session.activeStoryBranchId)) session.activeStoryBranchId = session.storyBranches[0].id;
    }
    const active = session.storyBranches.find(branch => branch.id === session.activeStoryBranchId) || session.storyBranches[0];
    session.activeStoryBranchId = active.id;
    // Reading a branch hydrates the current working session. Saving must not:
    // callers can legitimately replace session.messages / variables in one
    // assignment (imports, MVU commits, test fixtures), and that newer state
    // needs to flow into the active branch rather than be overwritten by it.
    if (hydrate) {
        session.messages = active.messages;
        session.variables = active.variables;
        session.variableSnapshots = active.variableSnapshots;
    }
    return active;
}

function syncStoryBranch(session) {
    const active = ensureStoryBranches(session, { hydrate: false });
    active.messages = session.messages;
    active.variables = session.variables;
    active.variableSnapshots = session.variableSnapshots;
    active.updatedAt = new Date().toISOString();
    return active;
}

export class GameStore extends EventTarget {
    constructor() {
        super();
        this.storageCompacted = false;
        this.storageAvailable = true;
        this.lastStorageError = null;
        this.data = this.load();
    }

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            const data = {
                ...clone(defaults),
                ...saved,
                settings: { ...clone(defaults.settings), ...(saved?.settings ?? {}) },
                connections: Array.isArray(saved?.connections) ? saved.connections : [],
                sessions: Array.isArray(saved?.sessions) ? saved.sessions : [],
            };
            data.settings.aiAssignments = {
                ...clone(defaults.settings.aiAssignments),
                ...(saved?.settings?.aiAssignments || {}),
            };
            data.sessions = data.sessions.map(session => {
                const normalized = { ...session, personalShop: { selectedIds: [], customItems: [], catalog: null, history: [], lastRefresh: null, extraRequirement: '', ...(session.personalShop || {}) }, variables: migrateVariables(session.variables), variableSnapshots: (session.variableSnapshots || []).map(snapshot => ({ ...snapshot, variables: migrateVariables(snapshot.variables) })) };
                if (Array.isArray(normalized.storyBranches)) normalized.storyBranches = normalized.storyBranches.map(branch => normalizeStoryBranch(branch));
                ensureStoryBranches(normalized);
                return normalized;
            });
            data.settings.maxTokens = Math.max(30000, Number(data.settings.maxTokens) || 32768);
            data.settings.uiScale = Math.min(1.5, Math.max(.85, Number(data.settings.uiScale) || 1));
            data.connections = data.connections.map(connection => ({ ...connection, maxTokens: Math.max(30000, Number(connection.maxTokens) || 32768) }));
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
            catch (error) {
                // Loading a valid oversized save must never fall through to
                // the outer catch and silently replace it with a blank game.
                this.storageCompacted = true;
                this.lastStorageError = error;
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(compactStoreForStorage(data, { emergency: true }))); }
                catch (compactError) { this.storageAvailable = false; this.lastStorageError = compactError; console.warn('[store] save-on-load compact fallback failed', compactError); }
            }
            return data;
        } catch {
            return clone(defaults);
        }
    }

    save() {
        this.data.sessions.forEach(syncStoryBranch);
        const persist = value => {
            const serialized = JSON.stringify(value);
            localStorage.setItem(STORAGE_KEY, serialized);
            return serialized.length;
        };
        try {
            if (this.storageCompacted) {
                persist(compactStoreForStorage(this.data));
            } else {
                persist(this.data);
            }
            this.storageAvailable = true;
        } catch (error) {
            if (!isQuotaError(error)) throw error;
            this.storageCompacted = true;
            this.lastStorageError = error;
            try {
                persist(compactStoreForStorage(this.data));
                this.storageAvailable = true;
            } catch (compactError) {
                try {
                    persist(compactStoreForStorage(this.data, { emergency: true }));
                    this.storageAvailable = true;
                } catch (emergencyError) {
                    // Keep the in-memory branch alive even when a browser has
                    // no room left at all. The next export/cleanup can still
                    // recover it; gameplay must not die inside a save call.
                    this.storageAvailable = false;
                    this.lastStorageError = emergencyError;
                    console.warn('[store] localStorage quota exhausted; changes remain in memory', emergencyError);
                }
            }
        }
        this.dispatchEvent(new Event('change'));
        return this.storageAvailable;
    }

    get activeSession() {
        return this.data.sessions.find(item => item.id === this.data.activeSessionId) ?? null;
    }

    createSession({ firstMessage = '【封面】', variables = {} } = {}) {
        const now = new Date().toISOString();
        const session = {
            id: crypto.randomUUID(),
            title: '新的轮回',
            createdAt: now,
            updatedAt: now,
            messages: firstMessage ? [{ id: crypto.randomUUID(), role: 'assistant', content: firstMessage, createdAt: now, swipes: [firstMessage], swipeIndex: 0 }] : [],
            personalShop: { selectedIds: [], customItems: [], catalog: null, history: [], lastRefresh: null, extraRequirement: '' },
            variables: migrateVariables(variables),
            variableSnapshots: [],
        };
        this.data.sessions.unshift(session);
        this.data.activeSessionId = session.id;
        this.save();
        return session;
    }

    selectSession(id) {
        if (!this.data.sessions.some(item => item.id === id)) return;
        this.data.activeSessionId = id;
        this.save();
    }

    storyBranches() {
        const session = this.activeSession;
        if (!session) return [];
        syncStoryBranch(session);
        return session.storyBranches;
    }

    activeStoryBranch() {
        const session = this.activeSession;
        return session ? ensureStoryBranches(session) : null;
    }

    selectStoryBranch(id) {
        const session = this.activeSession;
        if (!session) return null;
        syncStoryBranch(session);
        const branch = session.storyBranches.find(item => item.id === id);
        if (!branch) return null;
        session.activeStoryBranchId = branch.id;
        session.messages = branch.messages;
        session.variables = branch.variables;
        session.variableSnapshots = branch.variableSnapshots;
        session.updatedAt = new Date().toISOString();
        this.save();
        return branch;
    }

    forkStoryBranch(messageId, label = '') {
        const session = this.activeSession;
        if (!session) return null;
        const source = syncStoryBranch(session);
        const index = source.messages.findIndex(message => message.id === messageId);
        if (index < 0) return null;
        const original = source.messages[index];
        const forkKey = original.branchKey || crypto.randomUUID();
        original.branchKey = forkKey;
        const snapshots = source.variableSnapshots.filter(snapshot => snapshot.messageIndex < index);
        const inheritedVariables = snapshots.at(-1)?.variables ?? source.variables;
        const branch = normalizeStoryBranch({
            label: label || `分支 ${source.messages.filter(message => message.branchKey === forkKey).length + session.storyBranches.filter(item => item.forkKey === forkKey).length + 1}`,
            parentBranchId: source.id,
            forkKey,
            forkMessageId: messageId,
            messages: clone(source.messages.slice(0, index)),
            variables: clone(inheritedVariables),
            variableSnapshots: clone(snapshots),
        });
        session.storyBranches.push(branch);
        session.activeStoryBranchId = branch.id;
        session.messages = branch.messages;
        session.variables = branch.variables;
        session.variableSnapshots = branch.variableSnapshots;
        session.updatedAt = new Date().toISOString();
        this.save();
        return branch;
    }

    deleteSession(id) {
        this.data.sessions = this.data.sessions.filter(item => item.id !== id);
        if (this.data.activeSessionId === id) this.data.activeSessionId = this.data.sessions[0]?.id ?? null;
        this.save();
    }

    addMessage(role, content = '') {
        const session = this.activeSession;
        if (!session) return null;
        const now = new Date().toISOString();
        const message = { id: crypto.randomUUID(), role, content, createdAt: now, swipes: [content], swipeIndex: 0 };
        session.messages.push(message);
        session.updatedAt = now;
        if (role === 'user' && session.messages.filter(item => item.role === 'user').length === 1) {
            session.title = content.replace(/\s+/g, ' ').slice(0, 24) || '新的轮回';
        }
        this.save();
        return message;
    }

    updateMessage(id, content) {
        const message = this.activeSession?.messages.find(item => item.id === id);
        if (!message) return;
        message.content = content;
        message.swipes[message.swipeIndex] = content;
        this.activeSession.updatedAt = new Date().toISOString();
        this.save();
    }

    removeFrom(id) {
        const session = this.activeSession;
        const index = session?.messages.findIndex(item => item.id === id) ?? -1;
        if (index >= 0) {
            session.messages.splice(index);
            session.variableSnapshots = session.variableSnapshots.filter(item => item.messageIndex < index);
            const last = session.variableSnapshots.at(-1);
            if (last) session.variables = clone(last.variables);
            this.save();
        }
    }

    saveVariables(variables, messageIndex) {
        const session = this.activeSession;
        if (!session) return;
        session.variables = migrateVariables(variables);
        session.variableSnapshots = session.variableSnapshots.filter(item => item.messageIndex !== messageIndex);
        session.variableSnapshots.push({ messageIndex, variables: clone(session.variables) });
        this.save();
    }

    updateSettings(values) {
        Object.assign(this.data.settings, values);
        this.save();
    }

    saveConnection(connection) {
        const value = { id: connection.id || crypto.randomUUID(), createdAt: connection.createdAt || new Date().toISOString(), ...connection, updatedAt: new Date().toISOString() };
        value.maxTokens = Math.max(30000, Number(value.maxTokens) || 32768);
        const index = this.data.connections.findIndex(item => item.id === value.id);
        if (index >= 0) this.data.connections[index] = value;
        else this.data.connections.push(value);
        this.data.settings.activeConnectionId = value.id;
        this.syncActiveConnection(value);
        this.save();
        return value;
    }

    deleteConnection(id) {
        this.data.connections = this.data.connections.filter(item => item.id !== id);
        for (const field of ['storyConnectionId', 'combatConnectionId', 'shopConnectionId']) {
            if (this.data.settings.aiAssignments?.[field] === id) this.data.settings.aiAssignments[field] = null;
        }
        if (this.data.settings.activeConnectionId === id) {
            this.data.settings.activeConnectionId = this.data.connections[0]?.id ?? null;
            if (this.data.connections[0]) this.syncActiveConnection(this.data.connections[0]);
        }
        this.save();
    }

    selectConnection(id) {
        const connection = this.data.connections.find(item => item.id === id);
        if (!connection) return;
        this.data.settings.activeConnectionId = id;
        this.syncActiveConnection(connection);
        this.save();
    }

    syncActiveConnection(connection) {
        Object.assign(this.data.settings, {
            baseUrl: connection.baseUrl,
            apiKey: connection.apiKey,
            model: connection.model,
            protocol: connection.protocol,
            temperature: Number(connection.temperature ?? this.data.settings.temperature),
            maxTokens: Number(connection.maxTokens ?? this.data.settings.maxTokens),
            path: connection.path,
            modelsPath: connection.modelsPath,
            apiVersion: connection.apiVersion,
            extraHeaders: connection.extraHeaders,
            extraBody: connection.extraBody,
            testPrompt: connection.testPrompt,
        });
    }

    export() {
        return JSON.stringify({ format: 'battle-orb-save', version: 1, exportedAt: new Date().toISOString(), data: this.data }, null, 2);
    }
}
