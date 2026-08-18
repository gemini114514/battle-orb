import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const origin = 'http://127.0.0.1:4174';
const output = path.resolve('.test', 'max-scale');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-proxy-server'],
});

const panels = ['hub', 'chat', 'combat', 'status', 'shop', 'inventory', 'abilities', 'missions', 'world', 'relations', 'intel', 'archive', 'user-settings', 'settings'];
const required = {
    hub: ['.hero-actions button'],
    chat: ['#messageInput'],
    combat: ['[data-action="combat-start"]'],
    status: ['[data-action="open-setup"]'],
    shop: ['[data-action="open-setup-shop"]'],
    inventory: ['#inventoryContent'],
    abilities: ['#abilityContent'],
    missions: ['#missionContent'],
    world: ['#worldContent'],
    relations: ['#relationContent'],
    intel: ['#intelContent'],
    archive: ['[data-action="new-chat"]'],
    'user-settings': ['[data-action="new-user-profile"]', '#userProfileForm button[type="submit"]'],
    settings: ['.settings-tabs', '#settingsForm [data-action="save-settings"]'],
};

async function continueIntoApp(page) {
    const continueButton = page.getByRole('button', { name: /继续冒险/ });
    if (await continueButton.count()) {
        await continueButton.click();
        const agreement = page.locator('[data-cover-agree]');
        if (await agreement.count()) await agreement.check();
        const connect = page.getByRole('button', { name: '接入主神终端' });
        if (await connect.count()) await connect.click();
    }
    const startSetup = page.getByRole('button', { name: '开始建档' });
    if (await startSetup.count()) {
        await startSetup.click();
        await page.locator('#setupForm [name="name"]').fill('150%截图测试者');
        for (let index = 0; index < 4; index += 1) await page.getByRole('button', { name: '下一步' }).click();
        await page.getByRole('button', { name: '注入 MVU 并开始' }).click();
    }
    await page.locator('#messageInput').waitFor({ state: 'attached', timeout: 60000 });
}

async function openPanel(page, panel) {
    const bottom = page.locator(`.mobile-bottom-nav [data-panel="${panel}"]`);
    const canUseBottom = await bottom.count() && await bottom.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return getComputedStyle(node).display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
    });
    const rail = page.locator('#rail');
    if (await rail.evaluate(node => node.classList.contains('open'))) {
        await rail.locator(`.nav-item[data-panel="${panel}"]`).click();
    } else if (canUseBottom) {
        await bottom.click();
    } else {
        await page.locator('.mobile-menu').click();
        await rail.waitFor({ state: 'visible' });
        await rail.locator(`.nav-item[data-panel="${panel}"]`).click();
    }
    await page.locator(`#view-${panel}`).waitFor({ state: 'visible' });
    await page.waitForTimeout(260);
}

async function setMaxScale(page) {
    await openPanel(page, 'settings');
    await page.locator('[data-settings-tab="general"]').click();
    await page.locator('#settingsForm [name="uiScale"]').selectOption('1.5');
    await page.locator('[data-action="save-settings"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.uiScale === '1.5');
    await page.waitForTimeout(120);
}

async function visibleState(page, panel) {
    return page.evaluate(({ panel, selectors }) => {
        const view = document.querySelector(`#view-${panel}`);
        const visible = selector => {
            const node = view?.querySelector(selector);
            if (!node) return { selector, found: false, visible: false };
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
                selector,
                found: true,
                visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
                rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
            };
        };
        const rect = view?.getBoundingClientRect();
        return {
            panel,
            view: rect ? { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, scrollHeight: view.scrollHeight } : null,
            elements: selectors.map(visible),
        };
    }, { panel, selectors: required[panel] });
}

try {
    for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#runtimeBadge')?.classList.contains('ready'), null, { timeout: 60000 });
        await continueIntoApp(page);
        await setMaxScale(page);

        // The setup dialog's final “档案确认与持久化” page is the regression
        // reported by the user: its save/import controls must remain in the
        // viewport at maximum scale.
        await openPanel(page, 'status');
        await page.locator('#view-status [data-action="open-setup"]').click();
        await page.locator('#setupDialog[open]').waitFor();
        await page.evaluate(() => document.querySelector('[data-action="open-profiles"]')?.click());
        await page.locator('#setupDialog .setup-step[data-step="4"].active').waitFor();
        await page.screenshot({ path: path.join(output, `${name}-setup-profile-150.png`), fullPage: false });
        const setupState = await page.evaluate(() => {
            const selectors = ['#profileName', '[data-action="save-profile"]', '[data-action="import-profile"]', '#setupPrev', '#setupSubmit'];
            return selectors.map(selector => {
                const node = document.querySelector(`#setupDialog ${selector}`);
                const rect = node?.getBoundingClientRect();
                return { selector, visible: Boolean(node && rect && rect.width > 0 && rect.height > 0), rect: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } };
            });
        });
        assert.ok(setupState.every(item => item.visible), `${name}: 建立档案页控件不可见 ${JSON.stringify(setupState)}`);
        await page.evaluate(() => document.querySelector('[data-action="close-setup"]')?.click());
        await page.waitForTimeout(700);

        // The standalone user-profile editor has three header actions and a
        // persistent footer; check those too because it shares the same zoom
        // failure mode as the setup profile page.
        await openPanel(page, 'user-settings');
        await page.locator('[data-action="new-user-profile"]').click();
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(output, `${name}-user-profile-150.png`), fullPage: false });
        const profileState = await page.evaluate(() => ['[data-action="delete-user-profile"]', '[data-action="activate-user-profile"]', 'button[type="submit"]'].map(selector => {
            const node = document.querySelector(`#userProfileForm ${selector}`);
            const rect = node?.getBoundingClientRect();
            return { selector, visible: Boolean(node && rect && rect.width > 0 && rect.height > 0), rect: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } };
        }));
        assert.ok(profileState.every(item => item.visible), `${name}: 用户设定页控件不可见 ${JSON.stringify(profileState)}`);

        for (const panel of panels) {
            await openPanel(page, panel);
            const state = await visibleState(page, panel);
            assert.ok(state.elements.every(item => item.visible), `${name}/${panel}: 关键控件不可见 ${JSON.stringify(state)}`);
            await page.screenshot({ path: path.join(output, `${name}-${panel}-150.png`), fullPage: false });
        }
        assert.equal(errors.length, 0, `${name}: 页面异常\n${errors.join('\n')}`);
        console.log(`${name}: 150% screenshots and visibility checks passed`);
        await context.close();
    }
} finally {
    await browser.close();
}
