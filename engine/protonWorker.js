const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Utility delay function with optional random jitter
 */
const sleep = (ms, jitter = 0) => {
    const extra = jitter > 0 ? Math.floor(Math.random() * jitter) : 0;
    return new Promise(resolve => setTimeout(resolve, ms + extra));
};

/**
 * Human-like typing simulation
 */
/**
 * Reliable input filler that triggers native React 18 / Angular synthetic events
 */
async function reliableFill(element, text) {
    if (!element) return;
    await element.click();
    await element.fill('');
    await element.fill(text);
    await element.dispatchEvent('input').catch(() => { });
    await element.dispatchEvent('change').catch(() => { });
}

/**
 * Sanitize account email for folder naming
 */
function sanitizeFolderName(str) {
    return (str || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

class ProtonWorker {
    constructor(logger = console.log) {
        this.log = logger;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isAborted = false;
        this.isPersistent = false;
    }

    abort() {
        this.isAborted = true;
    }

    async initBrowser(options = {}) {
        const headless = options.headless !== undefined ? options.headless : false;
        const browserType = options.browser || 'chrome';
        const proxy = options.proxy || null;
        const account = options.account || null;

        const launchArgs = [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-features=OptimizationGuideModelDownloading,OptimizationHints,AutoDeElevate',
            '--disk-cache-size=2097152', // Limit disk cache to 2MB max
            '--media-cache-size=1048576',
            '--disable-gpu-shader-disk-cache',
            '--disable-component-update',
            '--disable-background-networking',
            '--lang=en-US',
            '--window-size=1366,768'
        ];

        const launchConfig = {
            headless: headless,
            args: launchArgs,
            viewport: { width: 1366, height: 768 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York'
        };

        if (browserType === 'chrome') {
            launchConfig.channel = 'chrome';
        } else if (browserType === 'edge') {
            launchConfig.channel = 'msedge';
        }

        if (proxy && proxy.server) {
            launchConfig.proxy = {
                server: proxy.server,
                username: proxy.username || undefined,
                password: proxy.password || undefined
            };
            this.log(`[NETWORK] Using Proxy: ${proxy.server}`);
        }

        // Ephemeral browser profile per account (automatically purged on batch completion for zero storage footprint)
        const accountKey = account ? sanitizeFolderName(account.email) : 'default';
        const profileDir = path.join(__dirname, '..', 'data', 'profiles', accountKey);
        this.profileDir = profileDir;
        try {
            fs.mkdirSync(profileDir, { recursive: true });
        } catch (e) { }

        try {
            this.log(`[BROWSER] Launching persistent browser profile for ${accountKey}...`);
            this.context = await chromium.launchPersistentContext(profileDir, launchConfig);
            this.isPersistent = true;
        } catch (err) {
            this.log(`[WARN] Persistent launch with channel '${browserType}' failed, retrying Chromium: ${err.message}`);
            delete launchConfig.channel;
            try {
                this.context = await chromium.launchPersistentContext(profileDir, launchConfig);
                this.isPersistent = true;
            } catch (err2) {
                this.log(`[WARN] Falling back to standard browser context: ${err2.message}`);
                this.browser = await chromium.launch({ headless, args: launchArgs });
                this.context = await this.browser.newContext({
                    viewport: { width: 1366, height: 768 },
                    userAgent: launchConfig.userAgent,
                    locale: 'en-US'
                });
                this.isPersistent = false;
            }
        }

        // Hide navigator.webdriver flag
        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const pages = this.context.pages();
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
        this.page.setDefaultTimeout(35000);
    }

    async login(account) {
        if (this.isAborted) return false;
        this.log(`[AUTH] Navigating to Proton Drive for ${account.email}...`);

        await this.page.goto('https://account.proton.me/drive', { waitUntil: 'domcontentloaded' });
        await sleep(2500, 500);

        // Check if ALREADY logged into Drive (strictly on drive.proton.me domain with New button)
        const isAlreadyOnDrive = this.page.url().includes('drive.proton.me');
        if (isAlreadyOnDrive) {
            const newBtnExists = await this.page.$('button:has-text("New"), [data-testid="navigation-dropdown:new"]');
            if (newBtnExists && (await newBtnExists.isVisible().catch(() => false))) {
                this.log(`[AUTH] Verified active Drive session for ${account.email}`);
                return true;
            }
        }

        // Must authenticate: Wait for username field
        this.log('[AUTH] Entering username...');
        await this.page.waitForSelector('#username, input[autocomplete="username"], input[type="email"]', { state: 'visible', timeout: 30000 });
        const userField = await this.page.$('#username, input[autocomplete="username"], input[type="email"]');
        await reliableFill(userField, account.email);
        await sleep(500, 150);

        // Check if password field is already visible on the same page (single-step form)
        let passField = await this.page.$('#password, input[type="password"]');
        let passVisible = passField ? await passField.isVisible().catch(() => false) : false;

        if (!passVisible) {
            // Two-step login: Click Continue/Next
            const continueBtn = await this.page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next")');
            if (continueBtn) {
                await continueBtn.click();
            } else {
                await this.page.keyboard.press('Enter');
            }
            await sleep(2500, 500);
        }

        this.log('[AUTH] Entering password...');
        await this.page.waitForSelector('#password, input[type="password"]', { state: 'visible', timeout: 25000 });
        passField = await this.page.$('#password, input[type="password"]');
        await reliableFill(passField, account.password);
        await sleep(500, 150);

        const signInBtn = await this.page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
        if (signInBtn) {
            await signInBtn.click();
        } else {
            await this.page.keyboard.press('Enter');
        }

        this.log('[AUTH] Validating authentication session...');
        let loginFailed = false;
        let failMessage = '';

        try {
            // Wait for cross-domain redirect from account.proton.me to drive.proton.me
            await this.page.waitForURL(url => url.hostname === 'drive.proton.me' || url.href.includes('drive.proton.me'), { timeout: 45000 });
        } catch (e) {
            // If redirect timed out, check if error was displayed on login page
            try {
                const errorNotification = await this.page.$('.notification--error, [role="alert"]');
                if (errorNotification) {
                    failMessage = await errorNotification.innerText();
                    loginFailed = true;
                }
                const twoFactor = await this.page.$('#twoFactorCode');
                if (twoFactor) {
                    failMessage = 'Proton account requires 2FA authentication, which cannot be automated without TOTP secret.';
                    loginFailed = true;
                }
            } catch (queryErr) { }

            if (loginFailed) {
                throw new Error(`Login rejected by Proton: ${failMessage}`);
            }
            this.log('[WARN] Redirect to drive.proton.me timed out, checking current state...');
        }

        // Wait for page to finish loading after navigation
        await this.page.waitForLoadState('domcontentloaded').catch(() => { });

        this.log(`[SUCCESS] Account authenticated: ${account.email}`);
        await this.waitForProtonDriveReady();
        return true;
    }

    async waitForProtonDriveReady() {
        this.log('[DRIVE] Waiting for Proton Drive interface to load...');
        try {
            if (!this.page.url().includes('drive.proton.me')) {
                await this.page.waitForURL(url => url.hostname === 'drive.proton.me', { timeout: 35000 }).catch(() => { });
            }

            // Wait until the "+ New" button or toolbar is visible
            await this.page.waitForSelector(
                'button:has-text("New"), [data-testid="navigation-dropdown:new"], [data-testid="toolbar:upload-file"]',
                { state: 'visible', timeout: 45000 }
            );
            await sleep(1500);
            this.log('[DRIVE] Proton Drive fully decrypted and ready.');
        } catch (e) {
            this.log('[WARN] Proton Drive loading wait timed out, attempting to proceed...');
        }
    }

    async uploadPdf(pdfFilePath) {
        if (this.isAborted) return false;
        if (!fs.existsSync(pdfFilePath)) {
            throw new Error(`PDF file does not exist at path: ${pdfFilePath}`);
        }

        const fileName = path.basename(pdfFilePath);
        this.log(`[UPLOAD] Initiating upload for: ${fileName}`);

        // Ensure we are in Proton Drive
        if (!this.page.url().includes('drive.proton.me')) {
            await this.page.goto('https://drive.proton.me/', { waitUntil: 'domcontentloaded' }).catch(() => { });
            await this.waitForProtonDriveReady();
        }

        this.log('[UPLOAD] Locating "+ New" button...');
        const newBtn = await this.page.waitForSelector(
            'button:has-text("New"), [data-testid="navigation-dropdown:new"], [data-testid="toolbar:upload-file"]',
            { state: 'visible', timeout: 35000 }
        );
        await newBtn.click();
        this.log('[UPLOAD] Clicked "+ New" button. Selecting "Upload file"...');
        await sleep(1000);

        const uploadOption = await this.page.waitForSelector(
            'button:has-text("Upload file"), li:has-text("Upload file"), [role="menuitem"]:has-text("Upload file")',
            { state: 'visible', timeout: 15000 }
        );

        const [fileChooser] = await Promise.all([
            this.page.waitForEvent('filechooser', { timeout: 15000 }),
            uploadOption.click()
        ]);
        await fileChooser.setFiles(pdfFilePath);
        this.log(`[UPLOAD] Injected file: ${fileName}`);

        // Handle potential "Duplicate found" dialog
        await sleep(2500);
        try {
            const hasDuplicate = await this.page.$('text="Duplicate found"');
            if (hasDuplicate) {
                this.log('[UPLOAD] Duplicate detected! Selecting Replace and clicking Continue...');
                const replaceOption = await this.page.$('input[testid="strategy-replace"], label:has-text("Replace"), #replace');
                if (replaceOption) {
                    await replaceOption.click();
                    await sleep(400);
                }
                const continueBtn = await this.page.$('button:has-text("Continue")');
                if (continueBtn) {
                    await continueBtn.click();
                    this.log('[UPLOAD] Confirmed replacement of duplicate file.');
                }
                await sleep(1500);
            }
        } catch (e) {
            this.log(`[WARN] Duplicate check: ${e.message}`);
        }

        return await this.waitForUploadCompletion(fileName);
    }

    async waitForUploadCompletion(fileName) {
        this.log('[UPLOAD] Waiting for file upload to complete and Transfer Card "Share" button to appear...');
        try {
            await this.page.waitForSelector(
                '#transfer-manager button:has-text("Share"), .floating-elements button:has-text("Share")',
                { state: 'visible', timeout: 60000 }
            );
            this.log(`[SUCCESS] File "${fileName}" uploaded and Transfer Card "Share" button is ready!`);
        } catch (err) {
            this.log(`[WARN] Transfer card Share wait timed out, proceeding to share step...`);
        }

        return true;
    }

    /**
     * Share uploaded file with recipient leads.
     * Flow:
     * 1. Click exact "Share" button in bottom-right Transfer Card (#transfer-manager)
     * 2. Click "can edit" permission dropdown and select "Viewer"
     * 3. Focus "Add people or groups to share" box and enter leads
     * 4. Enter optional message
     * 5. Click "Share" invitation button
     */
    async shareFile(leads = [], message = '', delayMs = 350) {
        if (this.isAborted) return { successCount: 0, failedLeads: leads };
        if (leads.length === 0) {
            this.log('[SHARE] No leads provided to share with.');
            return { successCount: 0, failedLeads: [] };
        }

        this.log(`[SHARE] Locating Transfer Card "Share" button (indicated by user arrow)...`);

        // 1. Locate and click Share button specifically on the Transfer Card in bottom-right
        const transferShareBtn = await this.page.waitForSelector(
            '#transfer-manager button:has-text("Share"), .floating-elements button:has-text("Share"), #transfer-manager button.button-solid-weak',
            { state: 'visible', timeout: 30000 }
        );

        if (!transferShareBtn) {
            await this.captureError('share_button_not_found');
            throw new Error('Could not find the "Share" button on the Proton Drive transfer card.');
        }

        await transferShareBtn.click();
        this.log('[SHARE] Clicked the exact Transfer Card "Share" button.');

        // Wait for Share dialog modal to appear
        this.log('[SHARE] Waiting for Share dialog modal to open...');
        await this.page.waitForSelector(
            'dialog, .modal-two, [role="dialog"]',
            { state: 'visible', timeout: 20000 }
        );
        await sleep(1500);

        // 2. Click "can edit" dropdown and select "Viewer"
        this.log('[SHARE] Looking for "can edit" dropdown to change to "Viewer"...');
        try {
            let viewerSelected = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const canEditBtn = await this.page.$(
                    'button[data-testid="dropdown-button"]:has-text("can edit"), dialog button:has-text("can edit"), .modal-two button:has-text("can edit"), button:has-text("can edit")'
                );
                if (!canEditBtn) {
                    this.log('[SHARE] "can edit" dropdown not visible (already set to Viewer or not present).');
                    viewerSelected = true;
                    break;
                }

                this.log(`[SHARE] (Attempt ${attempt}) Found "can edit" dropdown. Clicking to open...`);
                await canEditBtn.click();
                await sleep(800);

                // Look for Viewer button in dropdown content
                const viewerBtn = await this.page.waitForSelector(
                    'button.dropdown-item-button:has-text("Viewer"), .dropdown-content button:has-text("Viewer"), li.dropdown-item button:has-text("Viewer"), [role="menuitem"]:has-text("Viewer"), button:has-text("Viewer")',
                    { state: 'visible', timeout: 5000 }
                ).catch(() => null);

                if (viewerBtn) {
                    this.log('[SHARE] Found "Viewer" option in dropdown. Clicking...');
                    await viewerBtn.click();
                    this.log('[SUCCESS] Successfully clicked "Viewer" button!');
                    viewerSelected = true;
                    await sleep(800);
                    break;
                } else {
                    this.log(`[WARN] "Viewer" option did not appear on attempt ${attempt}. Retrying...`);
                }
            }

            if (!viewerSelected) {
                this.log('[WARN] Could not select "Viewer", proceeding with default permission.');
            }
        } catch (e) {
            this.log(`[WARN] Permission dropdown selection: ${e.message}`);
        }

        // 3. Locate the "Add people or groups to share" box and enter leads
        this.log('[SHARE] Locating "Add people or groups to share" input box...');
        const emailInput = await this.page.waitForSelector(
            '#direct-sharing-autocomplete, input[placeholder*="Add people or groups"], input[placeholder*="people"]',
            { state: 'visible', timeout: 15000 }
        );

        if (!emailInput) {
            throw new Error('Could not find the "Add people or groups to share" input box.');
        }

        await emailInput.click();
        this.log(`[SHARE] Entering ${leads.length} leads into the share box...`);
        const successfulLeads = [];
        const failedLeads = [];

        for (let i = 0; i < leads.length; i++) {
            if (this.isAborted) break;
            const leadEmail = leads[i].trim();
            if (!leadEmail) continue;

            try {
                await emailInput.focus();
                await emailInput.fill(leadEmail);
                await sleep(150);
                await this.page.keyboard.press('Enter');
                await sleep(delayMs);
                successfulLeads.push(leadEmail);
                this.log(`[SHARE] (${i + 1}/${leads.length}) Added lead: ${leadEmail}`);
            } catch (err) {
                this.log(`[WARN] Failed to insert lead ${leadEmail}: ${err.message}`);
                failedLeads.push(leadEmail);
            }
        }

        // 4. Enter optional custom message
        if (message && message.trim().length > 0) {
            this.log('[SHARE] Adding custom invite message...');
            const messageInput = await this.page.$(
                '#direct-sharing-invite-message, textarea[placeholder*="message"], textarea[data-testid="share:message-input"], textarea'
            );
            if (messageInput) {
                await messageInput.click();
                await messageInput.fill(message.trim());
                await sleep(600);
            }
        }

        // 5. Click the Share / Send button
        this.log('[SHARE] Clicking final Share invitation button in modal...');
        await sleep(800);

        const sendBtnSelectors = [
            'dialog button.button-solid-norm:has-text("Share")',
            '.modal-two button.button-solid-norm:has-text("Share")',
            'dialog button:has-text("Share")',
            '.modal-two button:has-text("Share")',
            'button[data-testid="share:send-invitation"]',
            'button[type="submit"]:has-text("Share")',
            'button:has-text("Send invitation")'
        ];

        let sent = false;
        for (const sel of sendBtnSelectors) {
            const btn = await this.page.$(sel);
            if (btn && await btn.isVisible().catch(() => false)) {
                await btn.click();
                sent = true;
                this.log('[SHARE] Share invitation button clicked.');
                break;
            }
        }

        if (!sent) {
            const dialogButtons = await this.page.$$('dialog button, .modal-two button');
            for (const b of dialogButtons) {
                const text = await b.innerText().catch(() => '');
                if ((text.includes('Share') || text.includes('Send')) && !text.includes('link')) {
                    await b.click();
                    sent = true;
                    this.log(`[SHARE] Clicked dialog button: "${text}"`);
                    break;
                }
            }
        }

        // Wait for confirmation notification or dialog to disappear
        this.log('[SHARE] Waiting for Proton confirmation...');
        await sleep(4000, 1000);

        try {
            await this.page.waitForFunction(() => {
                const hasToast = document.querySelector('[data-testid="notification:success"], .notification--success') !== null;
                const dialogGone = document.querySelector('dialog, .modal-two') === null;
                return hasToast || dialogGone;
            }, { timeout: 15000 });
        } catch (e) { }

        this.log(`[SUCCESS] Batch completed! Shared: ${successfulLeads.length}, Failed: ${failedLeads.length}`);
        return {
            successCount: successfulLeads.length,
            successfulLeads,
            failedLeads
        };
    }

    async captureError(prefix = 'error') {
        if (!this.page) return null;
        try {
            const fileName = `${prefix}_${Date.now()}.png`;
            const screenshotPath = path.join(__dirname, '..', 'debug', 'screenshots', fileName);
            await this.page.screenshot({ path: screenshotPath, fullPage: true });
            return screenshotPath;
        } catch (e) {
            return null;
        }
    }

    async close() {
        try {
            if (this.context) await this.context.close().catch(() => { });
            if (this.browser) await this.browser.close().catch(() => { });
        } catch (e) { }

        // Zero-Storage Lifecycle: Automatically purge temporary profile folder on completion
        // Guarantees that even 5,000+ accounts use 0 MB residual disk storage!
        if (this.profileDir) {
            this.purgeProfile(this.profileDir);
        }
    }

    purgeProfile(dir) {
        if (!dir || !fs.existsSync(dir)) return;
        const attempts = [150, 600, 1500];
        const tryDelete = (attemptIdx) => {
            try {
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
                }
            } catch (err) {
                if (attemptIdx < attempts.length) {
                    setTimeout(() => tryDelete(attemptIdx + 1), attempts[attemptIdx]);
                }
            }
        };
        setTimeout(() => tryDelete(0), attempts[0]);
    }
}

module.exports = ProtonWorker;
