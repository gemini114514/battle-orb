const DB_NAME = 'reincarnation-blackbox';
const DB_VERSION = 1;
const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|secret|password|access[-_]?token|refresh[-_]?token)/i;

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('events')) {
                const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
                events.createIndex('runId', 'runId');
                events.createIndex('sessionId', 'sessionId');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function tx(store, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
    });
}

function clean(value, key = '', seen = new WeakSet()) {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return /^(?:bearer|basic)\s+[a-z0-9._~+/=-]+$/i.test(value.trim()) ? '[REDACTED]' : value;
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (Array.isArray(value)) return value.map(item => clean(item, key, seen));
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, clean(item, childKey, seen)]));
}

function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class GameplayBlackBox extends EventTarget {
    constructor() {
        super();
        this.runId = crypto.randomUUID();
        this.sequence = 0;
        this.startedAt = new Date().toISOString();
        this.ready = this.initialize();
    }

    async initialize() {
        await tx('runs', 'readwrite', store => store.put({ id: this.runId, startedAt: this.startedAt, updatedAt: this.startedAt, userAgent: navigator.userAgent, appVersion: '0.1.0' }));
        await this.record('lifecycle', 'blackbox_started', { location: location.href });
        setTimeout(() => this.prune().catch(error => console.warn('[blackbox] prune failed', error)), 0);
    }

    async record(category, type, payload = {}, context = {}) {
        if (type !== 'blackbox_started') await this.ready;
        const event = clean({
            runId: this.runId,
            sequence: ++this.sequence,
            timestamp: new Date().toISOString(),
            elapsedMs: Math.round(performance.now()),
            category, type,
            sessionId: context.sessionId || null,
            turnId: context.turnId || null,
            payload,
        });
        try {
            await tx('events', 'readwrite', store => store.add(event));
            await tx('runs', 'readwrite', store => store.put({ id: this.runId, startedAt: this.startedAt, updatedAt: event.timestamp, eventCount: this.sequence, userAgent: navigator.userAgent, appVersion: '0.1.0' }));
            this.dispatchEvent(new CustomEvent('record', { detail: event }));
        } catch (error) { console.warn('[blackbox] record failed', error); }
        return event;
    }

    async events(runId = this.runId) {
        await this.ready;
        return (await tx('events', 'readonly', store => store.index('runId').getAll(runId))) || [];
    }

    async runs() {
        await this.ready;
        return ((await tx('runs', 'readonly', store => store.getAll())) || []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }

    async exportCurrent(snapshot = {}) {
        const sessionId = snapshot?.store?.activeSessionId || null;
        const runs = await this.runs();
        const allEvents = (await Promise.all(runs.map(run => this.events(run.id)))).flat();
        const events = allEvents.filter(event => event.runId === this.runId || (sessionId && event.sessionId === sessionId)).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
        const referencedRuns = runs.filter(run => events.some(event => event.runId === run.id));
        const payload = clean({ format: 'reincarnation-gameplay-blackbox', version: 1, exportedAt: new Date().toISOString(), activeRun: { id: this.runId, startedAt: this.startedAt }, sessionId, runs: referencedRuns, snapshot, events });
        download(`轮回战场-黑盒-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, payload);
        return payload;
    }

    async clear() {
        await Promise.all([tx('events', 'readwrite', store => store.clear()), tx('runs', 'readwrite', store => store.clear())]);
        this.sequence = 0; this.startedAt = new Date().toISOString();
        this.ready = this.initialize(); await this.ready;
    }

    async prune() {
        const runs = await this.runs();
        for (const run of runs.slice(30)) {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(['runs', 'events'], 'readwrite');
                transaction.objectStore('runs').delete(run.id);
                const cursor = transaction.objectStore('events').index('runId').openKeyCursor(IDBKeyRange.only(run.id));
                cursor.onsuccess = () => { const item = cursor.result; if (item) { transaction.objectStore('events').delete(item.primaryKey); item.continue(); } };
                transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
            });
        }
    }
}

export { clean as sanitizeBlackBoxData };
