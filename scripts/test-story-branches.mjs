import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/chat', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '第三条同层分支结果' } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }) }));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#runtimeBadge')?.classList.contains('ready'));
    const seeded = await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const session = app.store.activeSession;
        const now = new Date().toISOString();
        session.messages = [
            { id: 'opening', role: 'assistant', content: '开场', createdAt: now, swipes: ['开场'], swipeIndex: 0 },
            { id: 'action', role: 'user', content: '我选择前进。', createdAt: now, swipes: ['我选择前进。'], swipeIndex: 0 },
            { id: 'original', role: 'assistant', content: '原始同层结果', createdAt: now, swipes: ['原始同层结果'], swipeIndex: 0 },
        ];
        app.store.saveConnection({ name: 'branch-test', protocol: 'openai-chat', baseUrl: 'http://provider.test', path: '/v1/chat/completions', model: 'branch-test', temperature: .7, maxTokens: 30000, extraHeaders: '{}', extraBody: '{}', testPrompt: 'OK' });
        app.store.save();
        const branch = app.store.forkStoryBranch('original', '分支 2');
        const alternative = app.store.addMessage('assistant', '第二条同层分支结果');
        alternative.branchKey = branch.forkKey;
        app.store.save(); app.renderAll();
        return { forkKey: branch.forkKey, branchId: branch.id, branchCount: app.store.storyBranches().length };
    });
    assert.equal(seeded.branchCount, 2);
    await page.locator('.mobile-bottom-nav [data-panel="chat"]').click();
    await page.locator('[data-action="toggle-story-tools"]').click();
    await page.locator('[data-action="floor-next"]').click();
    await page.locator('#messages').getByText('第二条同层分支结果', { exact: true }).waitFor();
    assert.equal(await page.locator('#floorBranchButton').textContent(), '分支 2/2');
    await page.locator('[data-action="floor-branch-prev"]').click();
    await page.locator('#messages').getByText('原始同层结果', { exact: true }).waitFor();
    assert.equal(await page.locator('#floorBranchButton').textContent(), '分支 1/2');
    await page.locator('[data-action="floor-branch-next"]').click();
    await page.locator('#messages').getByText('第二条同层分支结果', { exact: true }).waitFor();
    assert.equal(await page.locator('#floorBranchButton').textContent(), '分支 2/2');

    const regen = page.locator('[data-action="regen-floor"]');
    await regen.click();
    assert.equal(await regen.textContent(), '再次点击确认');
    await regen.click();
    await page.locator('#messages').getByText('第三条同层分支结果', { exact: true }).waitFor();
    assert.equal(await page.locator('#floorBranchButton').textContent(), '分支 3/3');
    assert.equal(await page.locator('#floorTokenUsage').textContent(), 'Token 150');

    await page.locator('#floorBranchButton').click();
    await page.locator('#messages').getByText('原始同层结果', { exact: true }).waitFor();
    const persisted = await page.evaluate(() => ({
        branches: window.__reincarnationApp.store.storyBranches().map(branch => ({ id: branch.id, forkKey: branch.forkKey, contents: branch.messages.map(message => message.content) })),
        save: JSON.parse(localStorage.getItem('reincarnation-web:v1')).sessions.find(session => session.id === window.__reincarnationApp.store.activeSession.id).storyBranches.length,
    }));
    assert.equal(persisted.branches.length, 3);
    assert.equal(persisted.save, 3);
    assert.ok(persisted.branches.some(branch => branch.contents.includes('原始同层结果')));
    assert.ok(persisted.branches.some(branch => branch.contents.includes('第二条同层分支结果')));
    assert.ok(persisted.branches.some(branch => branch.contents.includes('第三条同层分支结果')));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('story branch and double-confirmation tests passed');
} finally {
    await browser.close();
}
