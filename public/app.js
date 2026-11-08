// State
let ws = null;
let currentTab = 'dashboard';
let isAuthVerified = false;

// ================= KeyAuth Licensing Client =================
async function checkAuthStatus() {
    // 1. Pre-fill credentials from localStorage if previously saved
    const savedUser = localStorage.getItem('byrion_auth_username') || '';
    const savedPass = localStorage.getItem('byrion_auth_password') || '';
    const rememberMe = localStorage.getItem('byrion_auth_remember') !== 'false';

    const userInput = document.getElementById('authUsernameInput');
    const passInput = document.getElementById('authPasswordInput');
    const rememberBox = document.getElementById('authRememberMe');

    if (userInput && savedUser) userInput.value = savedUser;
    if (passInput && savedPass) passInput.value = savedPass;
    if (rememberBox) rememberBox.checked = rememberMe;

    try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();

        if (data.authenticated) {
            isAuthVerified = true;
            onAuthSuccess(data);
            return true;
        } else {
            // If server auto-login is pending or if frontend has saved credentials, auto-authenticate
            if (savedUser && savedPass && rememberMe) {
                const statusText = document.getElementById('authStatusText');
                if (statusText) statusText.textContent = `Auto-logging in as ${savedUser}...`;
                return await executeAutoLogin(savedUser, savedPass);
            }

            isAuthVerified = false;
            showAuthModal('Please enter your username and password to log in.');
            return false;
        }
    } catch (e) {
        showAuthModal('Unable to connect to authorization service.');
        return false;
    }
}

async function executeAutoLogin(username, password) {
    const statusText = document.getElementById('authStatusText');
    const dot = document.getElementById('authStatusDot');
    const btnSubmit = document.getElementById('btnSubmitAuthLogin');
    const btnText = document.getElementById('btnSubmitAuthText');

    if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.classList.add('opacity-60', 'pointer-events-none');
    }
    if (btnText) btnText.textContent = 'AUTHENTICATING...';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            isAuthVerified = true;
            if (statusText) statusText.textContent = 'License verified! Loading dashboard...';
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
            setTimeout(() => {
                onAuthSuccess(data);
                initWebSocket();
                loadStats();
                loadAccounts();
                loadLeads();
                loadSettings();
            }, 300);
            return true;
        } else {
            isAuthVerified = false;
            const errorBox = document.getElementById('authErrorMessage');
            if (errorBox) {
                errorBox.textContent = data.error || 'Saved credentials are no longer valid.';
                errorBox.classList.remove('hidden');
            }
            if (statusText) statusText.textContent = 'Auto-login failed. Please enter credentials.';
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-400';
            showAuthModal();
            return false;
        }
    } catch (err) {
        showAuthModal('Authentication server offline.');
        return false;
    } finally {
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.classList.remove('opacity-60', 'pointer-events-none');
        }
        if (btnText) btnText.textContent = 'LOGIN';
    }
}

function showAuthModal(statusMessage) {
    const modal = document.getElementById('authModal');
    const headerAuth = document.getElementById('headerAuthContainer');
    if (modal) modal.classList.remove('hidden');
    if (headerAuth) {
        headerAuth.classList.add('hidden');
        headerAuth.classList.remove('flex');
    }
    if (statusMessage) {
        const statusText = document.getElementById('authStatusText');
        if (statusText) statusText.textContent = statusMessage;
    }
}

function hideAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.classList.add('hidden');
}

function onAuthSuccess(data) {
    hideAuthModal();
    const headerAuth = document.getElementById('headerAuthContainer');
    const userSpan = document.getElementById('headerAuthUser');
    const daysSpan = document.getElementById('headerAuthDays');
    if (headerAuth && userSpan && daysSpan) {
        userSpan.textContent = data.currentUser || data.username || 'User';
        const days = (data.subscriptionDaysLeft !== undefined ? data.subscriptionDaysLeft : (data.daysLeft !== undefined ? data.daysLeft : 'Active'));
        daysSpan.textContent = `${days} Days`;
        headerAuth.classList.remove('hidden');
        headerAuth.classList.add('flex');
    }
}

async function handleAuthLogin(e) {
    e.preventDefault();
    const username = document.getElementById('authUsernameInput').value.trim();
    const password = document.getElementById('authPasswordInput').value.trim();
    const errorBox = document.getElementById('authErrorMessage');
    const btnSubmit = document.getElementById('btnSubmitAuthLogin');
    const btnText = document.getElementById('btnSubmitAuthText');
    const statusText = document.getElementById('authStatusText');

    if (!username || !password) {
        if (errorBox) {
            errorBox.textContent = 'Please enter both username and password.';
            errorBox.classList.remove('hidden');
        }
        return;
    }

    if (errorBox) errorBox.classList.add('hidden');
    btnSubmit.disabled = true;
    btnSubmit.classList.add('opacity-60', 'pointer-events-none');
    btnText.textContent = 'AUTHENTICATING...';
    if (statusText) statusText.textContent = 'Connecting to KeyAuth server...';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            isAuthVerified = true;
            // Save in localStorage if Remember Me is checked
            const rememberMe = document.getElementById('authRememberMe') ? document.getElementById('authRememberMe').checked : true;
            if (rememberMe) {
                localStorage.setItem('byrion_auth_username', username);
                localStorage.setItem('byrion_auth_password', password);
                localStorage.setItem('byrion_auth_remember', 'true');
            } else {
                localStorage.removeItem('byrion_auth_username');
                localStorage.removeItem('byrion_auth_password');
                localStorage.setItem('byrion_auth_remember', 'false');
            }

            if (statusText) statusText.textContent = 'Login Successful! Access granted.';
            const dot = document.getElementById('authStatusDot');
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
            
            setTimeout(() => {
                onAuthSuccess(data);
                initWebSocket();
                loadStats();
                loadAccounts();
                loadLeads();
                loadSettings();
            }, 400);
        } else {
            throw new Error(data.error || 'Access denied by administrator or invalid credentials.');
        }
    } catch (err) {
        if (errorBox) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hidden');
        }
        if (statusText) statusText.textContent = 'Authentication Failed.';
        const dot = document.getElementById('authStatusDot');
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-400';
    } finally {
        btnSubmit.disabled = false;
        btnSubmit.classList.remove('opacity-60', 'pointer-events-none');
        btnText.textContent = 'LOGIN';
    }
}

async function authLogout() {
    if (confirm('Are you sure you want to log out of your license?')) {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch (e) { }
        localStorage.removeItem('byrion_auth_username');
        localStorage.removeItem('byrion_auth_password');
        isAuthVerified = false;
        location.reload();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Intercept unauthorized requests
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const res = await originalFetch(...args);
        if (res.status === 401 && typeof args[0] === 'string' && !args[0].includes('/api/auth/')) {
            showAuthModal('License access required. Please login or contact administrator.');
        }
        return res;
    };

    // 2. Verify KeyAuth authorization
    const authed = await checkAuthStatus();
    if (authed) {
        initWebSocket();
        loadStats();
        loadAccounts();
        loadLeads();
        loadSettings();
        checkAppUpdates();
    }
});

// ================= Auto Updater =================
let pendingUpdateUrl = null;

async function checkAppUpdates() {
    try {
        const res = await fetch('/api/update/check');
        const data = await res.json();
        if (data.success && data.updateAvailable) {
            pendingUpdateUrl = data.downloadUrl;
            const banner = document.getElementById('updateBanner');
            const bannerText = document.getElementById('updateBannerText');
            if (banner && bannerText) {
                bannerText.textContent = `Update v${data.latestVersion} Available`;
                banner.classList.remove('hidden');
                banner.classList.add('flex');
            }
        }
    } catch (e) { }
}

async function triggerAppUpdate() {
    if (!pendingUpdateUrl) return;
    const btn = document.getElementById('btnApplyUpdate');
    const bannerText = document.getElementById('updateBannerText');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'pointer-events-none');
        btn.textContent = 'Downloading...';
    }
    if (bannerText) bannerText.textContent = 'Downloading update (0%)...';

    try {
        await fetch('/api/update/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadUrl: pendingUpdateUrl })
        });
    } catch (err) {
        if (bannerText) bannerText.textContent = 'Update failed.';
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'pointer-events-none');
            btn.textContent = 'Retry';
        }
    }
}

// WebSocket Setup
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        // Connected silently
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'log') {
                appendLog(data.payload);
            } else if (data.type === 'stats' || data.type === 'init') {
                updateStatsUI(data.payload.stats || data.payload);
            } else if (data.type === 'update_progress') {
                const bannerText = document.getElementById('updateBannerText');
                if (bannerText) bannerText.textContent = `Downloading update (${data.payload.percent}%)...`;
            } else if (data.type === 'update_ready') {
                const bannerText = document.getElementById('updateBannerText');
                if (bannerText) bannerText.textContent = `Update ready! Restarting Proton Drive Pro...`;
            } else if (data.type === 'update_error') {
                const bannerText = document.getElementById('updateBannerText');
                if (bannerText) bannerText.textContent = `Update error: ${data.payload.message}`;
            }
        } catch (e) { }
    };

    ws.onclose = () => {
        appendLog({ time: new Date().toLocaleTimeString(), message: '[WS] Connection lost. Reconnecting in 3s...', type: 'warn' });
        setTimeout(initWebSocket, 3000);
    };
}

// Logging
function appendLog(logEntry) {
    const consoleEl = document.getElementById('logConsole');
    if (!consoleEl) return;

    const div = document.createElement('div');
    const typeClass = `log-${logEntry.type || 'info'}`;
    div.className = `${typeClass} leading-relaxed`;
    div.textContent = `[${logEntry.time}] ${logEntry.message}`;

    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole() {
    const consoleEl = document.getElementById('logConsole');
    if (consoleEl) {
        consoleEl.innerHTML = '<div class="text-slate-500">[SYSTEM] Log cleared.</div>';
    }
}

// Tab Switching
function switchTab(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    const activeTab = document.getElementById(`tab-${tabId}`);
    const activeNav = document.getElementById(`nav-${tabId}`);
    if (activeTab) activeTab.classList.remove('hidden');
    if (activeNav) activeNav.classList.add('active');

    if (tabId === 'accounts') loadAccounts();
    if (tabId === 'leads') loadLeads();
    if (tabId === 'pdf') loadSettings();
    if (tabId === 'settings') loadSettings();
}

// Update UI Stats
function updateStatsUI(stats) {
    if (!stats) return;

    // Remaining Leads in queue to send
    const remaining = stats.remainingLeads !== undefined ? stats.remainingLeads : (stats.totalLeads || 0);
    const sent = stats.successCount || 0;
    const failed = stats.failedCount || 0;
    const total = stats.totalLeads || (remaining + sent);

    document.getElementById('statTotalLeads').textContent = remaining;
    document.getElementById('statSuccessCount').textContent = sent;
    document.getElementById('statFailedCount').textContent = failed;
    if (document.getElementById('badgeLeadsCount')) {
        document.getElementById('badgeLeadsCount').textContent = remaining;
    }

    if (stats.accountsReady !== undefined) {
        document.getElementById('statAccountsReady').textContent = stats.accountsReady;
    }
    if (document.getElementById('badgeAccountsCount') && stats.totalAccounts !== undefined) {
        document.getElementById('badgeAccountsCount').textContent = stats.totalAccounts;
    }

    const leadSuccEl = document.getElementById('consoleLeadSuccess');
    const leadFailEl = document.getElementById('consoleLeadFailed');
    if (leadSuccEl) leadSuccEl.textContent = `${sent} Sent`;
    if (leadFailEl) leadFailEl.textContent = `${failed} Failed`;

    const accSuccEl = document.getElementById('consoleAccSuccess');
    const accFailEl = document.getElementById('consoleAccFailed');
    if (accSuccEl) accSuccEl.textContent = `${stats.accountsUsed || 0} Used`;
    if (accFailEl) accFailEl.textContent = `${stats.accountsError || 0} Error`;

    const activeThreads = stats.activeThreads || 0;
    const maxThreads = stats.maxThreads || 1;
    const statActiveThreadsEl = document.getElementById('statActiveThreads');
    const statMaxThreadsEl = document.getElementById('statMaxThreads');
    if (statActiveThreadsEl) statActiveThreadsEl.textContent = activeThreads;
    if (statMaxThreadsEl) statMaxThreadsEl.textContent = maxThreads;

    const activeThreadsBadge = document.getElementById('activeThreadsBadge');
    const activeThreadsText = document.getElementById('activeThreadsText');
    if (activeThreadsBadge && activeThreadsText) {
        if (stats.status === 'RUNNING') {
            activeThreadsBadge.classList.remove('hidden');
            activeThreadsText.textContent = `Threads: ${activeThreads} / ${maxThreads} Active`;
        } else {
            activeThreadsBadge.classList.add('hidden');
        }
    }

    // Progress percentage
    let percent = 0;
    if (stats.status === 'RUNNING' || stats.status === 'PAUSED') {
        const campaignTotal = stats.totalLeads > 0 ? stats.totalLeads : (remaining + sent);
        percent = campaignTotal > 0 ? Math.round((sent / campaignTotal) * 100) : 0;
    } else {
        percent = 0; // Fresh 0% when IDLE
    }
    document.getElementById('progressPercent').textContent = `${percent}%`;
    document.getElementById('progressBar').style.width = `${percent}%`;

    // Status badges & buttons
    const status = stats.status || 'IDLE';
    const statusText = document.getElementById('statusIndicatorText');
    const statusDot = document.getElementById('statusIndicatorDot');

    statusText.textContent = status;

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnResume = document.getElementById('btnResume');
    const btnStop = document.getElementById('btnStop');

    if (status === 'RUNNING') {
        statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping';
        btnStart.classList.add('hidden');
        btnPause.classList.remove('hidden');
        btnResume.classList.add('hidden');
        btnStop.classList.remove('hidden');
    } else if (status === 'PAUSED') {
        statusDot.className = 'w-2 h-2 rounded-full bg-amber-400';
        btnStart.classList.add('hidden');
        btnPause.classList.add('hidden');
        btnResume.classList.remove('hidden');
        btnStop.classList.remove('hidden');
    } else {
        statusDot.className = 'w-2 h-2 rounded-full bg-slate-400';
        btnStart.classList.remove('hidden');
        btnPause.classList.add('hidden');
        btnResume.classList.add('hidden');
        btnStop.classList.add('hidden');
    }

    if (stats.currentAccount) {
        document.getElementById('sidebarActiveAccount').textContent = stats.currentAccount;
    }

    // Auto-refresh active tab tables during active running campaign (throttled)
    if (stats.status === 'RUNNING') {
        if (currentTab === 'leads' && !window._fetchingLeads) {
            window._fetchingLeads = true;
            loadLeads().finally(() => { setTimeout(() => { window._fetchingLeads = false; }, 1500); });
        }
        if (currentTab === 'accounts' && !window._fetchingAccounts) {
            window._fetchingAccounts = true;
            loadAccounts().finally(() => { setTimeout(() => { window._fetchingAccounts = false; }, 1500); });
        }
    }
}

async function loadStats() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        updateStatsUI(data.stats);
    } catch (e) { }
}

// Campaign Controls
async function startCampaign() {
    try {
        const res = await fetch('/api/campaign/start', { method: 'POST' });
        const data = await res.json();
        if (!data.success) alert(data.message);
    } catch (err) {
        alert('Failed to connect to server.');
    }
}

async function pauseCampaign() {
    await fetch('/api/campaign/pause', { method: 'POST' });
}

async function resumeCampaign() {
    await fetch('/api/campaign/resume', { method: 'POST' });
}

async function stopCampaign() {
    if (confirm('Are you sure you want to stop the campaign?')) {
        await fetch('/api/campaign/stop', { method: 'POST' });
    }
}

// Accounts Management
async function loadAccounts() {
    try {
        const res = await fetch('/api/accounts');
        const accounts = await res.json();

        document.getElementById('badgeAccountsCount').textContent = accounts.length;
        document.getElementById('statAccountsReady').textContent = accounts.filter(a => a.status === 'ready').length;

        const tbody = document.getElementById('accountsTableBody');
        if (!tbody) return;

        if (accounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500">No accounts loaded yet.</td></tr>';
            return;
        }

        tbody.innerHTML = accounts.map(acc => {
            let statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Ready (প্রস্তুত)</span>';
            if (acc.status === 'used') {
                statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">Used (ব্যবহৃত)</span>';
            } else if (acc.status === 'error') {
                statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20" title="${acc.errorMsg || 'Error'}">Error</span>`;
            }

            return `
            <tr class="hover:bg-slate-900/40 transition">
                <td class="py-3 px-6 font-mono text-slate-200">${acc.email}</td>
                <td class="py-3 px-6">${statusBadge}</td>
                <td class="py-3 px-6 font-mono">${acc.sentCount || 0}</td>
                <td class="py-3 px-6 text-slate-400">${acc.lastUsed ? new Date(acc.lastUsed).toLocaleTimeString() : 'Never'}</td>
                <td class="py-3 px-6 text-right">
                    <button onclick="deleteAccount('${acc.id}')" class="text-slate-500 hover:text-rose-400 transition" title="Delete Account">
                        <i class="ph-bold ph-trash"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) { }
}

async function importAccounts() {
    const raw = document.getElementById('importAccountsText').value.trim();
    if (!raw) return alert('Please paste at least one account.');

    try {
        const res = await fetch('/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawAccounts: raw })
        });
        const data = await res.json();
        document.getElementById('importAccountsText').value = '';
        loadAccounts();
        alert(`Successfully imported ${data.count} accounts.`);
    } catch (err) {
        alert('Failed to import accounts.');
    }
}

async function deleteAccount(id) {
    if (confirm('Delete this account?')) {
        await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
        loadAccounts();
    }
}

async function clearAccounts() {
    if (confirm('Are you sure you want to clear ALL accounts?')) {
        await fetch('/api/accounts/clear', { method: 'POST' });
        loadAccounts();
    }
}

async function resetAccountsStatus() {
    if (!confirm('আপনি কি সব অ্যাকাউন্টের স্ট্যাটাস রিসেট করে Ready করতে চান?')) return;
    try {
        await fetch('/api/accounts/reset', { method: 'POST' });
        await loadAccounts();
        alert('সকল অ্যাকাউন্ট সফলভাবে Ready করা হয়েছে!');
    } catch (e) {
        alert('Failed to reset accounts: ' + e.message);
    }
}

// ==========================================
// Leads Management (High-Performance Paginated)
// ==========================================
let leadsCurrentPage = 1;
const LEADS_PER_PAGE = 50;
let leadSearchQuery = '';
let leadSearchTimeout = null;

async function loadLeads() {
    try {
        const queryParams = new URLSearchParams({
            page: leadsCurrentPage,
            limit: LEADS_PER_PAGE
        });
        if (leadSearchQuery) {
            queryParams.set('search', leadSearchQuery);
        }

        const res = await fetch(`/api/leads?${queryParams.toString()}`);
        const data = await res.json();

        if (data && data.leads !== undefined) {
            const grandTotal = data.grandTotal !== undefined ? data.grandTotal : data.total;
            if (document.getElementById('badgeLeadsCount')) {
                document.getElementById('badgeLeadsCount').textContent = grandTotal;
            }
            if (document.getElementById('statTotalLeads')) {
                document.getElementById('statTotalLeads').textContent = grandTotal;
            }
            renderLeadsPaginated(data);
        } else if (Array.isArray(data)) {
            // Fallback for raw array response
            const grandTotal = data.length;
            if (document.getElementById('badgeLeadsCount')) {
                document.getElementById('badgeLeadsCount').textContent = grandTotal;
            }
            if (document.getElementById('statTotalLeads')) {
                document.getElementById('statTotalLeads').textContent = grandTotal;
            }

            let filtered = data;
            if (leadSearchQuery) {
                const q = leadSearchQuery.toLowerCase();
                filtered = filtered.filter(l => l.email.toLowerCase().includes(q));
            }
            const total = filtered.length;
            const totalPages = Math.max(1, Math.ceil(total / LEADS_PER_PAGE));
            if (leadsCurrentPage > totalPages) leadsCurrentPage = totalPages;
            if (leadsCurrentPage < 1) leadsCurrentPage = 1;

            const startIdx = (leadsCurrentPage - 1) * LEADS_PER_PAGE;
            const slice = filtered.slice(startIdx, startIdx + LEADS_PER_PAGE);

            renderLeadsPaginated({
                leads: slice,
                total: total,
                totalPages: totalPages,
                page: leadsCurrentPage,
                limit: LEADS_PER_PAGE,
                grandTotal: grandTotal
            });
        }
    } catch (e) {
        console.error('Failed to load leads:', e);
    }
}

function onLeadSearchChange() {
    clearTimeout(leadSearchTimeout);
    leadSearchTimeout = setTimeout(() => {
        const searchInput = document.getElementById('leadSearchInput');
        leadSearchQuery = searchInput ? searchInput.value.trim() : '';
        leadsCurrentPage = 1;
        loadLeads();
    }, 250);
}

function renderLeadsPaginated(pageData) {
    const tbody = document.getElementById('leadsTableBody');
    const countEl = document.getElementById('leadsTableCount');
    if (countEl) countEl.textContent = pageData.grandTotal !== undefined ? pageData.grandTotal : pageData.total;
    if (!tbody) return;

    const total = pageData.total || 0;
    const totalPages = Math.max(1, pageData.totalPages || 1);
    leadsCurrentPage = pageData.page || 1;

    // Control Elements
    const pageEl = document.getElementById('leadCurrentPage');
    const totalPagesEl = document.getElementById('leadTotalPages');
    const showingStartEl = document.getElementById('leadsShowingStart');
    const showingEndEl = document.getElementById('leadsShowingEnd');
    const showingTotalEl = document.getElementById('leadsShowingTotal');
    const btnFirst = document.getElementById('btnLeadFirst');
    const btnPrev = document.getElementById('btnLeadPrev');
    const btnNext = document.getElementById('btnLeadNext');
    const btnLast = document.getElementById('btnLeadLast');

    if (pageEl) pageEl.textContent = leadsCurrentPage;
    if (totalPagesEl) totalPagesEl.textContent = totalPages;

    const startIdx = total === 0 ? 0 : (leadsCurrentPage - 1) * (pageData.limit || LEADS_PER_PAGE);
    const endIdx = total === 0 ? 0 : Math.min(startIdx + (pageData.leads ? pageData.leads.length : 0), total);

    if (showingStartEl) showingStartEl.textContent = total === 0 ? 0 : startIdx + 1;
    if (showingEndEl) showingEndEl.textContent = endIdx;
    if (showingTotalEl) showingTotalEl.textContent = total;

    if (btnFirst) btnFirst.disabled = leadsCurrentPage <= 1;
    if (btnPrev) btnPrev.disabled = leadsCurrentPage <= 1;
    if (btnNext) btnNext.disabled = leadsCurrentPage >= totalPages;
    if (btnLast) btnLast.disabled = leadsCurrentPage >= totalPages;

    if (!pageData.leads || pageData.leads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-slate-500">No leads found in queue. All leads processed or none imported.</td></tr>';
        return;
    }

    tbody.innerHTML = pageData.leads.map((lead, idx) => {
        const globalIdx = startIdx + idx + 1;
        let badge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Ready (অপেক্ষমান)</span>';
        if (lead.status === 'processing') {
            badge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20 animate-pulse">Sending...</span>';
        } else if (lead.status === 'failed') {
            badge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20" title="${lead.errorMsg || 'Failed'}">Failed (ব্যর্থ)</span>`;
        }

        return `
        <tr class="hover:bg-slate-900/40 transition">
            <td class="py-2.5 px-6 text-slate-500 text-xs">${globalIdx}</td>
            <td class="py-2.5 px-6 font-mono text-slate-200 text-xs">${lead.email}</td>
            <td class="py-2.5 px-6">${badge}</td>
            <td class="py-2.5 px-6 text-right">
                <button onclick="deleteLead('${lead.id}')" title="Delete lead" class="text-slate-500 hover:text-rose-400 transition">
                    <i class="ph-bold ph-trash"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
}

function changeLeadsPage(delta) {
    leadsCurrentPage += delta;
    loadLeads();
}

function goToLeadsPage(target) {
    if (target === 'last') {
        const totalPagesEl = document.getElementById('leadTotalPages');
        leadsCurrentPage = totalPagesEl ? parseInt(totalPagesEl.textContent) || 1 : 1;
    } else {
        leadsCurrentPage = parseInt(target) || 1;
    }
    loadLeads();
}

async function deleteLead(id) {
    try {
        await fetch(`/api/leads/${id}`, { method: 'DELETE' });
        loadLeads();
        loadStats();
    } catch (e) {
        alert('Failed to delete lead.');
    }
}

async function importLeads() {
    const raw = document.getElementById('importLeadsText').value.trim();
    if (!raw) return alert('Please enter at least one valid lead email.');

    try {
        const res = await fetch('/api/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawLeads: raw })
        });
        const data = await res.json();
        document.getElementById('importLeadsText').value = '';
        leadsCurrentPage = 1;
        loadLeads();
        loadStats();
        alert(`Successfully imported target leads! Total in queue: ${data.count}`);
    } catch (err) {
        alert('Failed to import leads.');
    }
}

async function clearLeads() {
    if (confirm('Are you sure you want to clear ALL leads from queue?')) {
        await fetch('/api/leads/clear', { method: 'POST' });
        leadsCurrentPage = 1;
        loadLeads();
        loadStats();
    }
}

async function resetLeadsStatus() {
    if (confirm('Reset all leads back to Pending status?')) {
        await fetch('/api/leads/reset', { method: 'POST' });
        loadLeads();
        loadStats();
        alert('All remaining leads reset to pending status.');
    }
}

async function saveMessageSetting() {
    const msg = document.getElementById('customInviteMessage').value.trim();
    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inviteMessage: msg })
        });
        const badge = document.getElementById('msgSavedBadge');
        if (badge) {
            badge.classList.remove('hidden');
            setTimeout(() => badge.classList.add('hidden'), 2500);
        }
    } catch (e) {
        alert('Failed to save message.');
    }
}

// PDF Management
async function handlePdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('pdf', file);

    try {
        const res = await fetch('/api/upload-pdf', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            alert(`PDF "${data.fileName}" uploaded and selected successfully!`);
            loadSettings();
        } else {
            alert(data.message || 'Upload failed');
        }
    } catch (err) {
        alert('Failed to upload PDF.');
    }
}

// Settings
async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        const settings = data.settings || {};

        document.getElementById('settingHeadless').value = settings.headless ? 'true' : 'false';
        document.getElementById('settingBrowser').value = settings.browser || 'chrome';
        const threadsInput = document.getElementById('settingThreads');
        if (threadsInput) {
            threadsInput.value = settings.threads || 1;
            const badge = document.getElementById('threadCountBadge');
            if (badge) badge.textContent = (settings.threads || 1) + ((settings.threads || 1) == 1 ? ' Thread' : ' Threads');
        }
        document.getElementById('settingLeadsPerAccount').value = settings.leadsPerAccount || 10;
        document.getElementById('settingDelay').value = settings.delayBetweenLeadsMs || 350;
        document.getElementById('customInviteMessage').value = settings.inviteMessage || '';

        if (settings.proxies && settings.proxies.length > 0) {
            document.getElementById('settingProxyServer').value = settings.proxies[0].server || '';
        }

        // Active PDF indicators
        const activePdfName = settings.selectedPdf ? settings.selectedPdf.split(/[\\/]/).pop() : 'None selected';
        document.getElementById('sidebarActivePdf').textContent = activePdfName;

        // Render PDF list
        const pdfContainer = document.getElementById('pdfListContainer');
        if (pdfContainer && data.availablePdfs) {
            if (data.availablePdfs.length === 0) {
                pdfContainer.innerHTML = '<div class="text-xs text-slate-500">No PDF uploaded yet. Click above to upload.</div>';
            } else {
                pdfContainer.innerHTML = data.availablePdfs.map(pdf => {
                    const isSelected = settings.selectedPdf === pdf.filePath;
                    return `
                        <div class="flex items-center justify-between p-3 rounded-xl border ${isSelected ? 'border-purple-500/50 bg-purple-500/10' : 'border-slate-800 bg-slate-950'} text-xs">
                            <div class="flex items-center gap-3">
                                <i class="ph-bold ph-file-pdf text-xl ${isSelected ? 'text-purple-400' : 'text-slate-500'}"></i>
                                <div>
                                    <div class="font-medium text-slate-200">${pdf.fileName}</div>
                                    <div class="text-[10px] text-slate-500">${(pdf.size / 1024).toFixed(1)} KB</div>
                                </div>
                            </div>
                            <button onclick="selectPdf('${pdf.filePath.replace(/\\/g, '\\\\')}')" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${isSelected ? 'bg-purple-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'} transition">
                                ${isSelected ? 'Selected' : 'Use this'}
                            </button>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (e) { }
}

async function selectPdf(filePath) {
    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedPdf: filePath })
    });
    loadSettings();
}

async function saveAllSettings() {
    const headless = document.getElementById('settingHeadless').value === 'true';
    const browser = document.getElementById('settingBrowser').value;
    const threads = parseInt(document.getElementById('settingThreads')?.value) || 1;
    const leadsPerAccount = parseInt(document.getElementById('settingLeadsPerAccount').value) || 10;
    const delayBetweenLeadsMs = parseInt(document.getElementById('settingDelay').value) || 350;
    const proxyServer = document.getElementById('settingProxyServer').value.trim();

    const payload = {
        headless,
        browser,
        threads,
        leadsPerAccount,
        delayBetweenLeadsMs,
        proxies: proxyServer ? [{ server: proxyServer }] : []
    };

    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    alert('Settings saved successfully!');
}

// Window bindings for HTML event listeners (guarantees compatibility with obfuscation)
window.startCampaign = startCampaign;
window.pauseCampaign = pauseCampaign;
window.resumeCampaign = resumeCampaign;
window.stopCampaign = stopCampaign;
window.switchTab = switchTab;
window.clearConsole = clearConsole;
window.importAccounts = importAccounts;
window.deleteAccount = deleteAccount;
window.clearAccounts = clearAccounts;
window.resetAccountsStatus = resetAccountsStatus;
window.importLeads = importLeads;
window.deleteLead = deleteLead;
window.clearLeads = clearLeads;
window.resetLeadsStatus = resetLeadsStatus;
window.saveMessageSetting = saveMessageSetting;
window.handlePdfUpload = handlePdfUpload;
window.selectPdf = selectPdf;
window.saveAllSettings = saveAllSettings;
window.changeLeadsPage = changeLeadsPage;
window.goToLeadsPage = goToLeadsPage;
window.onLeadSearchChange = onLeadSearchChange;

