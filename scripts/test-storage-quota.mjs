import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reservePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
});
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, REINCARNATION_PORT: String(port) } });
const waitHealth = async () => { for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('测试服务器未启动'); };
let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__reincarnationApp);
    const result = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const session = app.store.activeSession;
        if (!session?.messages?.length) throw new Error('测试需要至少一条消息');
        const message = session.messages.at(-1);
        message.promptTrace = { sentAt: new Date().toISOString(), model: 'quota-test', protocol: 'openai-chat', messages: [{ role: 'system', content: 'x'.repeat(6_000_000) }] };
        const proto = Object.getPrototypeOf(localStorage);
        const original = proto.setItem;
        proto.setItem = function (key, value) {
            if (key === 'reincarnation-web:v1' && String(value).length > 100_000) throw new DOMException('simulated localStorage quota', 'QuotaExceededError');
            return original.call(this, key, value);
        };
        let fork;
        let error = null;
        try { fork = app.store.forkStoryBranch(message.id, '配额降级测试'); } catch (caught) { error = caught; }
        proto.setItem = original;
        return { error: error?.message || null, forked: Boolean(fork), branchCount: session.storyBranches?.length || 0, compacted: app.store.storageCompacted, storageAvailable: app.store.storageAvailable, savedBytes: String(localStorage.getItem('reincarnation-web:v1') || '').length };
    });
    assert.equal(result.error, null);
    assert.equal(result.forked, true);
    assert.equal(result.compacted, true);
    assert.equal(result.storageAvailable, true);
    assert.ok(result.savedBytes < 100_000, `降级存档仍过大：${result.savedBytes}`);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally { await browser?.close(); server.kill(); }
