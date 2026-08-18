import { chromium } from 'playwright-core';

const context = await chromium.launchPersistentContext('C:\\SillyTavern\\reincarnation-web\\.test\\profile-copy-20260813', {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
    args: ['--no-proxy-server', '--profile-directory=Default'], viewport: { width: 1440, height: 1000 },
});
try {
    const page = context.pages()[0] || await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.presets().length);
    await page.locator('[data-panel="settings"]').first().click();

    // AIRP：只编辑当前条目，并确认该条目的其它字段仍在同一表单中。
    await page.locator('[data-settings-tab="presets"]').click();
    await page.locator('#presetList [data-preset-id]').first().click();
    const promptForm = page.locator('#promptEntryEditor');
    const promptName = promptForm.locator('[name="name"]');
    const originalPromptName = await promptName.inputValue();
    const modifiedPromptName = `${originalPromptName} · 局部编辑测试`;
    await promptName.fill(modifiedPromptName);
    await promptForm.locator('button[type="submit"]').click();
    const savedPromptName = await promptForm.locator('[name="name"]').inputValue();
    await promptForm.locator('[name="name"]').fill(originalPromptName);
    await promptForm.locator('button[type="submit"]').click();

    // Regex：卡内规则编辑会生成副本；启用控件全部为无文字、带 tooltip 的 checkbox。
    await page.locator('[data-settings-tab="regex"]').click();
    await page.locator('#regexPresetList [data-regex-preset-id="card"]').click();
    const regexForm = page.locator('#regexEntryEditor');
    const originalRegexName = await regexForm.locator('[name="scriptName"]').inputValue();
    const modifiedRegexName = `${originalRegexName} · 局部编辑测试`;
    await regexForm.locator('[name="scriptName"]').fill(modifiedRegexName);
    await regexForm.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#regexPresetList .manager-item.active')?.dataset.regexPresetId !== 'card');
    const savedRegexName = await regexForm.locator('[name="scriptName"]').inputValue();
    const selectedPresetId = await page.locator('#regexPresetList .manager-item.active').getAttribute('data-regex-preset-id');
    const checkboxAudit = await page.evaluate(() => [...document.querySelectorAll('#regexPresetEnabled, [data-regex-toggle], #regexEntryEditor input[type="checkbox"]')].every(input => input.closest('label')?.title && ![...input.closest('label').childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())));
    await page.locator('[data-action="delete-regex-preset"]').click();

    await page.locator('[data-settings-tab="blackbox"]').click();
    const result = await page.evaluate(async () => {
        const events = await window.__reincarnationApp.blackbox.events();
        return {
            events: events.length,
            promptSaves: events.filter(item => item.type === 'preset_entry_saved').length,
            regexSaves: events.filter(item => item.type === 'regex_entry_saved').length,
            hasSecretLeak: events.some(item => JSON.stringify(item).includes(window.__reincarnationApp.store.data.settings.apiKey)),
        };
    });
    console.log(JSON.stringify({ savedPromptName, modifiedPromptName, savedRegexName, modifiedRegexName, selectedPresetId, checkboxAudit, ...result, pageErrors: errors }, null, 2));
    if (savedPromptName !== modifiedPromptName || savedRegexName !== modifiedRegexName || selectedPresetId === 'card' || !checkboxAudit || result.promptSaves < 2 || result.regexSaves < 1 || result.hasSecretLeak || errors.length) process.exitCode = 1;
} finally { await context.close(); }
