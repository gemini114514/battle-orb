import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp && document.querySelectorAll('#personalShopContent [data-starter-id]').length > 50);
    await page.evaluate(() => {
        const app = window.__reincarnationApp;
        const message = app.store.addMessage('assistant', '可审计剧情正文');
        message.promptTrace = { model: 'audit-model', messages: [{ role: 'system', content: 'SYSTEM SECRET TEST' }, { role: 'user', content: 'ACTION' }] };
        message.tokenUsage = { inputTokens: 1234, outputTokens: 321, totalTokens: 1555, exact: true, raw: { prompt_tokens: 1234 } };
        app.store.save(); app.renderAll();
    });
    await page.locator('[data-panel="chat"]').first().click();
    while (await page.locator('[data-action="floor-next"]').isEnabled()) await page.locator('[data-action="floor-next"]').click();
    await page.locator('[data-action="view-floor-prompt"]').click();
    const readonlyPrompt = await page.locator('#textEditorValue').isEditable();
    const promptText = await page.locator('#textEditorValue').inputValue();
    await page.locator('[data-editor-action="close"]').last().click();
    await page.locator('[data-action="view-floor-tokens"]').click();
    const usageText = await page.locator('#textEditorValue').inputValue();
    await page.locator('[data-editor-action="close"]').last().click();
    await page.locator('[data-action="edit-floor"]').click();
    await page.locator('#textEditorValue').fill('文本编辑器保存后的剧情');
    await page.locator('[data-editor-action="save"]').click();
    await page.locator('#messages').getByText('文本编辑器保存后的剧情', { exact: true }).waitFor();
    const embeddedActions = await page.locator('#messages [data-message-action]').count();

    await page.locator('[data-panel="shop"]').click();
    const firstShopItem = page.locator('#personalShopContent [data-starter-id]:not(:disabled)').first();
    const selectedId = await firstShopItem.getAttribute('data-starter-id');
    await firstShopItem.click();
    const firstSession = await page.evaluate(() => ({ id: window.__reincarnationApp.store.activeSession.id, selected: [...window.__reincarnationApp.store.activeSession.personalShop.selectedIds] }));
    await page.evaluate(() => window.__reincarnationApp.newSession());
    const secondSession = await page.evaluate(() => ({ id: window.__reincarnationApp.store.activeSession.id, selected: [...window.__reincarnationApp.store.activeSession.personalShop.selectedIds] }));
    console.log(JSON.stringify({ readonlyPrompt, promptTextHasSecret: promptText.includes('SYSTEM SECRET TEST'), usageTextHas1555: usageText.includes('1555'), embeddedActions, selectedId, firstSession, secondSession, pageErrors: errors }, null, 2));
    if (readonlyPrompt || !promptText.includes('SYSTEM SECRET TEST') || !usageText.includes('1555') || embeddedActions || !firstSession.selected.includes(selectedId) || firstSession.id === secondSession.id || secondSession.selected.length || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
