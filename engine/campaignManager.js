const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const ProtonWorker = require('./protonWorker');

class CampaignManager extends EventEmitter {
    constructor() {
        super();
        this.status = 'IDLE'; // IDLE | RUNNING | PAUSED | STOPPED
        this.activeWorkers = new Map(); // workerId -> { worker, threadId, account, leads, startTime }
        this.stats = {
            campaignTotalLeads: 0,
            totalLeads: 0,
            processedLeads: 0,
            successCount: 0,
            failedCount: 0,
            activeThreads: 0,
            maxThreads: 1,
            currentAccount: null,
            startTime: null
        };

        // Clean up any stale in-progress states on boot
        this.cleanupInterruptedState();
        // Archive old history so fresh app boot starts with clean 0 sent
        this.refreshSessionOnBoot();
        // Purge any stale profile folders so storage is always strictly 0 MB
        this.cleanupStaleProfiles();
    }

    cleanupStaleProfiles() {
        const profilesDir = path.join(__dirname, '..', 'data', 'profiles');
        try {
            if (fs.existsSync(profilesDir)) {
                const items = fs.readdirSync(profilesDir);
                for (const item of items) {
                    const fullPath = path.join(profilesDir, item);
                    try {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                    } catch (err) { }
                }
            }
        } catch (e) { }
    }

    refreshSessionOnBoot() {
        const paths = this.getDataPaths();
        try {
            const history = this.loadData(paths.history, []);
            if (Array.isArray(history) && history.length > 0) {
                const archivePath = path.join(__dirname, '..', 'data', 'history_archive.json');
                const existingArchive = this.loadData(archivePath, []);
                existingArchive.push(...history);
                this.saveData(archivePath, existingArchive);
                // Clear active history so fresh run starts at 0
                this.saveData(paths.history, []);
            }
        } catch (e) {
            this.log(`[STORAGE] Error archiving history on boot: ${e.message}`, 'warn');
        }
    }

    log(message, type = 'info') {
        const time = new Date().toLocaleTimeString();
        const logEntry = { time, message, type };
        this.emit('log', logEntry);
    }

    getStats() {
        const paths = this.getDataPaths();
        const accounts = this.loadData(paths.accounts, []);
        const leads = this.loadData(paths.leads, []);

        const accReady = accounts.filter(a => a.status === 'ready').length;
        const accUsed = accounts.filter(a => a.status === 'used').length;
        const accError = accounts.filter(a => a.status === 'error').length;
        const remainingLeads = leads.length;
        const sentInSession = this.stats.successCount || 0;
        const failedInSession = this.stats.failedCount || 0;
        const campaignTotal = this.stats.campaignTotalLeads || (remainingLeads + sentInSession);

        return {
            status: this.status,
            totalLeads: campaignTotal,
            remainingLeads: remainingLeads,
            successCount: sentInSession,
            failedCount: failedInSession,
            activeThreads: this.activeWorkers.size,
            maxThreads: this.stats.maxThreads || 1,
            currentAccount: this.stats.currentAccount,
            accountsReady: accReady,
            accountsUsed: accUsed,
            accountsError: accError,
            totalAccounts: accounts.length
        };
    }

    emitStats() {
        this.emit('stats', this.getStats());
    }

    getDataPaths() {
        return {
            accounts: path.join(__dirname, '..', 'data', 'accounts.json'),
            leads: path.join(__dirname, '..', 'data', 'leads.json'),
            settings: path.join(__dirname, '..', 'data', 'settings.json'),
            history: path.join(__dirname, '..', 'data', 'history.json')
        };
    }

    loadData(filePath, fallback = []) {
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            }
        } catch (e) {
            this.log(`[STORAGE] Error reading ${path.basename(filePath)}: ${e.message}`, 'error');
        }
        return fallback;
    }

    saveData(filePath, data) {
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            this.log(`[STORAGE] Error saving ${path.basename(filePath)}: ${e.message}`, 'error');
        }
    }

    /**
     * Reverts any dangling in_use accounts back to ready and processing leads back to pending.
     */
    cleanupInterruptedState() {
        const paths = this.getDataPaths();
        try {
            const accounts = this.loadData(paths.accounts, []);
            let accChanged = false;
            for (const acc of accounts) {
                if (acc.status === 'in_use') {
                    acc.status = 'ready';
                    accChanged = true;
                }
            }
            if (accChanged) this.saveData(paths.accounts, accounts);

            const leads = this.loadData(paths.leads, []);
            let leadsChanged = false;
            for (const lead of leads) {
                if (lead.status === 'processing') {
                    lead.status = 'pending';
                    leadsChanged = true;
                }
            }
            if (leadsChanged) this.saveData(paths.leads, leads);
        } catch (e) { }
    }

    /**
     * Atomically claims 1 ready account and up to leadsPerAccount pending leads.
     * Synchronous execution in Node.js prevents any race condition between threads.
     */
    claimBatchAndAccount(leadsPerAccount) {
        const paths = this.getDataPaths();
        const accounts = this.loadData(paths.accounts, []);
        const leads = this.loadData(paths.leads, []);

        // 1. Find first unused account with status 'ready'
        const readyAccountIndex = accounts.findIndex(a => a.status === 'ready');
        if (readyAccountIndex === -1) {
            return { error: 'no_accounts' };
        }

        // 2. Find pending leads (or failed leads for retry)
        const pendingLeads = [];
        for (const l of leads) {
            if (l.status === 'pending' || l.status === 'failed') {
                pendingLeads.push(l);
                if (pendingLeads.length >= leadsPerAccount) break;
            }
        }

        if (pendingLeads.length === 0) {
            return { error: 'no_leads' };
        }

        // 3. Mark account as 'in_use'
        const claimedAccount = accounts[readyAccountIndex];
        claimedAccount.status = 'in_use';
        claimedAccount.claimedAt = new Date().toISOString();
        this.saveData(paths.accounts, accounts);

        // 4. Mark selected leads as 'processing'
        const claimedIds = new Set(pendingLeads.map(l => l.id));
        for (const l of leads) {
            if (claimedIds.has(l.id)) {
                l.status = 'processing';
            }
        }
        this.saveData(paths.leads, leads);

        return {
            account: { ...claimedAccount },
            leads: pendingLeads.map(l => ({ ...l }))
        };
    }

    /**
     * Finalizes successfully shared leads by CUTTING THEM OUT from leads.json
     * and permanently archiving them into history.json.
     */
    finalizeLeadsSuccess(accountEmail, shareResult, batchLeads, threadId = 1) {
        const paths = this.getDataPaths();
        let leads = this.loadData(paths.leads, []);
        let history = this.loadData(paths.history, []);

        const successfulSet = new Set(shareResult.successfulLeads || []);
        const failedSet = new Set(shareResult.failedLeads || []);
        const batchIds = new Set(batchLeads.map(l => l.id));

        const cutLeads = [];
        const remainingLeads = [];

        for (const l of leads) {
            if (batchIds.has(l.id)) {
                // If it succeeded
                if (successfulSet.has(l.email) || (!failedSet.has(l.email) && successfulSet.size === 0)) {
                    this.stats.successCount++;
                    this.log(`[LEAD] ${l.email} -> SUCCESS (Cut from list) [Thread-${threadId}]`, 'success');
                    cutLeads.push({
                        id: l.id,
                        email: l.email,
                        status: 'sent',
                        sentAt: new Date().toISOString(),
                        accountUsed: accountEmail
                    });
                } else if (failedSet.has(l.email)) {
                    l.status = 'failed';
                    l.errorMsg = 'Share failed';
                    this.stats.failedCount++;
                    this.log(`[LEAD] ${l.email} -> FAILED [Thread-${threadId}]`, 'error');
                    remainingLeads.push(l);
                } else {
                    // Default to success
                    this.stats.successCount++;
                    this.log(`[LEAD] ${l.email} -> SUCCESS (Cut from list) [Thread-${threadId}]`, 'success');
                    cutLeads.push({
                        id: l.id,
                        email: l.email,
                        status: 'sent',
                        sentAt: new Date().toISOString(),
                        accountUsed: accountEmail
                    });
                }
            } else {
                remainingLeads.push(l);
            }
        }

        // 1. Cut sent leads completely from leads file: save only remaining leads
        this.saveData(paths.leads, remainingLeads);

        // 2. Archive cut leads in history so user can export sent leads at any time
        if (cutLeads.length > 0) {
            history.push(...cutLeads);
            this.saveData(paths.history, history);
        }
    }

    finalizeAccountUsed(accountId, accountEmail, successCount, threadId = 1) {
        const paths = this.getDataPaths();
        const accounts = this.loadData(paths.accounts, []);
        const acc = accounts.find(a => a.id === accountId);
        if (acc) {
            acc.sentCount = (acc.sentCount || 0) + (successCount || 0);
            acc.lastUsed = new Date().toISOString();
            acc.status = 'used'; // Single-use policy
            this.saveData(paths.accounts, accounts);
            this.log(`[ACCOUNT] ${accountEmail} -> SUCCESS (${successCount} leads sent) [Thread-${threadId}]`, 'success');
        }
    }

    finalizeBatchFailure(accountId, accountEmail, batchLeads, errorMsg, threadId = 1) {
        const paths = this.getDataPaths();
        // Mark batch leads as failed
        const leads = this.loadData(paths.leads, []);
        const batchIds = new Set(batchLeads.map(l => l.id));
        for (const l of leads) {
            if (batchIds.has(l.id)) {
                l.status = 'failed';
                l.errorMsg = errorMsg;
                this.stats.failedCount++;
                this.log(`[LEAD] ${l.email} -> FAILED (${errorMsg}) [Thread-${threadId}]`, 'error');
            }
        }
        this.saveData(paths.leads, leads);

        // Mark account as error
        const accounts = this.loadData(paths.accounts, []);
        const acc = accounts.find(a => a.id === accountId);
        if (acc) {
            acc.status = 'error';
            acc.errorMsg = errorMsg;
            this.saveData(paths.accounts, accounts);
            this.log(`[ACCOUNT] ${accountEmail} -> FAILED (${errorMsg}) [Thread-${threadId}]`, 'error');
        }
    }

    getProcessedCount() {
        const paths = this.getDataPaths();
        const leads = this.loadData(paths.leads, []);
        const history = this.loadData(paths.history, []);
        return history.length + leads.filter(l => l.status === 'failed').length;
    }

    async start() {
        if (this.status === 'RUNNING') {
            this.log('[CAMPAIGN] Campaign is already running.', 'warn');
            return;
        }

        this.cleanupInterruptedState();

        const paths = this.getDataPaths();
        const settings = this.loadData(paths.settings, {});
        const accounts = this.loadData(paths.accounts, []);
        const leads = this.loadData(paths.leads, []);

        const readyAccounts = accounts.filter(a => a.status === 'ready');
        if (readyAccounts.length === 0) {
            this.log('[CAMPAIGN] Cannot start: No ready Proton accounts found. Reset used accounts or import new ones.', 'error');
            return;
        }

        if (leads.length === 0) {
            this.log('[CAMPAIGN] Cannot start: Lead List is empty. Please import target leads in Leads tab first.', 'error');
            return;
        }

        // Auto-recover any failed or interrupted leads in leads.json so Start ALWAYS runs seamlessly
        let leadsChanged = false;
        for (const l of leads) {
            if (l.status !== 'pending') {
                l.status = 'pending';
                l.errorMsg = null;
                leadsChanged = true;
            }
        }
        if (leadsChanged) {
            this.saveData(paths.leads, leads);
        }

        if (!settings.selectedPdf || !fs.existsSync(settings.selectedPdf)) {
            this.log(`[CAMPAIGN] Cannot start: Selected PDF file does not exist. Upload a PDF first.`, 'error');
            return;
        }

        const maxThreads = Math.max(1, Math.min(10, parseInt(settings.threads) || 1));

        this.status = 'RUNNING';
        this.stats = {
            campaignTotalLeads: leads.length,
            totalLeads: leads.length,
            processedLeads: 0,
            successCount: 0,
            failedCount: 0,
            activeThreads: 0,
            maxThreads: maxThreads,
            currentAccount: null,
            startTime: new Date()
        };
        this.emitStats();

        this.log(`==================================================================================`, 'info');
        this.log(`[CAMPAIGN] Starting Multi-Threaded Campaign!`, 'success');
        this.log(`[CAMPAIGN] Threads: ${maxThreads} | Remaining Leads: ${leads.length} | Ready Accounts: ${readyAccounts.length}`, 'info');
        this.log(`==================================================================================`, 'info');

        // Launch the worker pool
        this.runPool();
    }

    /**
     * Main concurrent pool loop.
     */
    async runPool() {
        const paths = this.getDataPaths();

        while (this.status === 'RUNNING') {
            // Re-read settings dynamically so thread count changes apply in real-time
            const settings = this.loadData(paths.settings, {});
            const maxThreads = Math.max(1, Math.min(10, parseInt(settings.threads) || 1));
            const leadsPerAccount = Math.max(1, parseInt(settings.leadsPerAccount) || 10);
            this.stats.maxThreads = maxThreads;

            // 1. If pool is full, wait for any worker to finish
            if (this.activeWorkers.size >= maxThreads) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            // 2. Check if paused
            if (this.status === 'PAUSED') {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            if (this.status === 'STOPPING' || this.status === 'STOPPED') {
                break;
            }

            // 3. Atomically claim next account and leads batch
            const claim = this.claimBatchAndAccount(leadsPerAccount);

            if (claim.error === 'no_accounts') {
                if (this.activeWorkers.size === 0) {
                    this.log('[CAMPAIGN] All accounts have been used once (Single-use policy completed). Stopping campaign.', 'success');
                    this.status = 'IDLE';
                    this.stats.activeThreads = 0;
                    this.emitStats();
                    break;
                }
                // Other threads are still running, wait for them
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            if (claim.error === 'no_leads') {
                if (this.activeWorkers.size === 0) {
                    this.log('[CAMPAIGN] All leads have been processed! Campaign finished successfully.', 'success');
                    this.status = 'IDLE';
                    this.stats.activeThreads = 0;
                    this.emitStats();
                    break;
                }
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            // 4. Determine available thread number (1 to maxThreads)
            const usedThreadNums = new Set(Array.from(this.activeWorkers.values()).map(w => w.threadId));
            let threadId = 1;
            for (let i = 1; i <= 20; i++) {
                if (!usedThreadNums.has(i)) {
                    threadId = i;
                    break;
                }
            }

            // 5. Spawn worker thread asynchronously
            const workerId = `worker_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
            this.runWorkerThread(workerId, threadId, claim.account, claim.leads, settings);

            // Stagger multiple browser launches by 2.5 seconds to prevent system CPU spikes
            await new Promise(r => setTimeout(r, 2500));
        }
    }

    /**
     * Executes a single worker task independently in parallel.
     */
    async runWorkerThread(workerId, threadId, account, leadsBatch, settings) {
        const delayBetweenLeads = parseInt(settings.delayBetweenLeadsMs) || 350;
        // Detailed DOM debug logs go to Node terminal only; keep user Live Console clean
        const worker = new ProtonWorker((msg) => {
            console.log(`[Thread-${threadId}] ${msg}`);
        });

        this.activeWorkers.set(workerId, {
            worker,
            threadId,
            account,
            leads: leadsBatch,
            startTime: Date.now()
        });

        this.stats.activeThreads = this.activeWorkers.size;
        this.stats.currentAccount = account.email;
        this.emitStats();

        this.log(`[ACCOUNT] ${account.email} -> STARTED (${leadsBatch.length} leads) [Thread-${threadId}]`, 'info');

        try {
            // Initialize Browser (Isolated persistent profile per account)
            await worker.initBrowser({
                headless: settings.headless,
                browser: settings.browser,
                proxy: settings.proxies && settings.proxies.length > 0 ? settings.proxies[0] : null,
                account
            });

            // Login
            const loginSuccess = await worker.login(account);
            if (!loginSuccess) {
                throw new Error(`Authentication incomplete for ${account.email}`);
            }

            // Upload PDF
            await worker.uploadPdf(settings.selectedPdf);

            // Share with leads
            const leadEmails = leadsBatch.map(l => l.email);
            const shareResult = await worker.shareFile(leadEmails, settings.inviteMessage, delayBetweenLeads);

            // Update leads (CUT from leads.json & archive) and account
            this.finalizeLeadsSuccess(account.email, shareResult, leadsBatch, threadId);
            this.finalizeAccountUsed(account.id, account.email, shareResult.successCount, threadId);

        } catch (err) {
            await worker.captureError(`thread_${threadId}_fail`);
            this.finalizeBatchFailure(account.id, account.email, leadsBatch, err.message, threadId);
        } finally {
            await worker.close();
            this.activeWorkers.delete(workerId);
            this.stats.activeThreads = this.activeWorkers.size;
            this.stats.processedLeads = this.getProcessedCount();
            this.emitStats();
        }
    }

    pause() {
        if (this.status === 'RUNNING') {
            this.status = 'PAUSED';
            this.log('[CAMPAIGN] Pausing campaign. Active threads will finish their current batch...', 'warn');
            this.emitStats();
        }
    }

    resume() {
        if (this.status === 'PAUSED') {
            this.status = 'RUNNING';
            this.log('[CAMPAIGN] Resuming multi-threaded campaign...', 'info');
            this.emitStats();
            this.runPool();
        }
    }

    async stop() {
        this.status = 'STOPPED';
        this.log(`[CAMPAIGN] Terminating all active threads (${this.activeWorkers.size} active)...`, 'warn');

        const closePromises = [];
        for (const [id, entry] of this.activeWorkers.entries()) {
            entry.worker.abort();
            closePromises.push(entry.worker.close());
        }
        await Promise.all(closePromises);
        this.activeWorkers.clear();

        this.cleanupInterruptedState();

        this.log('[CAMPAIGN] All worker threads terminated cleanly.', 'error');
        this.status = 'IDLE';
        this.stats.activeThreads = 0;
        this.emitStats();
    }
}

module.exports = new CampaignManager();
