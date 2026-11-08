const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { exec, spawn } = require('child_process');

const campaignManager = require('./engine/campaignManager');
const keyAuth = require('./engine/keyAuth');
const autoUpdater = require('./engine/autoUpdater');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Storage paths
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Helper functions
const readJson = (file, fallback = []) => {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { }
    return fallback;
};

const writeJson = (file, data) => {
    try {
        const content = (Array.isArray(data) && data.length > 500)
            ? JSON.stringify(data)
            : JSON.stringify(data, null, 2);
        fs.writeFileSync(file, content, 'utf8');
    } catch (e) {
        console.error(`[STORAGE] Error writing ${file}:`, e.message);
    }
};

// Multer upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
        cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() === '.pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are supported.'));
        }
    }
});

// Broadcast helper for WebSocket
function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Hook up campaign manager events to WebSocket
campaignManager.on('log', (logEntry) => broadcast('log', logEntry));
campaignManager.on('stats', (stats) => broadcast('stats', stats));

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            status: campaignManager.status,
            stats: campaignManager.getStats()
        }
    }));
});

// ================= AUTHENTICATION ROUTES (KeyAuth) =================
app.get('/api/auth/status', async (req, res) => {
    let status = keyAuth.getStatus();
    if (!status.authenticated) {
        try {
            const autoResult = await keyAuth.tryAutoLogin();
            if (autoResult) {
                status = keyAuth.getStatus();
            }
        } catch (e) { }
    }
    res.json(status);
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await keyAuth.login(username, password);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    keyAuth.logout();
    res.json({ success: true });
});

// Middleware: Gate all subsequent /api routes with license authorization
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) {
        return next();
    }
    const status = keyAuth.getStatus();
    if (!status.authenticated) {
        return res.status(401).json({ error: 'License verification required. Access is locked until granted by administrator.' });
    }
    next();
});

// ================= API ROUTES =================

// Campaign controls
app.get('/api/status', (req, res) => {
    res.json({
        status: campaignManager.status,
        stats: campaignManager.getStats()
    });
});

app.post('/api/campaign/start', async (req, res) => {
    campaignManager.start();
    res.json({ success: true, message: 'Campaign started' });
});

app.post('/api/campaign/pause', (req, res) => {
    campaignManager.pause();
    res.json({ success: true, message: 'Campaign paused' });
});

app.post('/api/campaign/resume', (req, res) => {
    campaignManager.resume();
    res.json({ success: true, message: 'Campaign resumed' });
});

app.post('/api/campaign/stop', async (req, res) => {
    await campaignManager.stop();
    res.json({ success: true, message: 'Campaign stopped' });
});

// Accounts
app.get('/api/accounts', (req, res) => {
    res.json(readJson(ACCOUNTS_FILE, []));
});

app.post('/api/accounts', (req, res) => {
    const { rawAccounts } = req.body;
    let accounts = readJson(ACCOUNTS_FILE, []);

    if (rawAccounts && typeof rawAccounts === 'string') {
        const lines = rawAccounts.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const existingEmails = new Set(accounts.map(a => a.email.toLowerCase()));
        const now = Date.now();

        lines.forEach((line, idx) => {
            const parts = line.split(/[:,|\t]/).map(p => p.trim());
            if (parts.length >= 2) {
                const email = parts[0];
                const password = parts[1];
                const recovery = parts[2] || '';
                const lower = email.toLowerCase();
                if (!existingEmails.has(lower)) {
                    existingEmails.add(lower);
                    accounts.push({
                        id: 'acc_' + now + '_' + idx + '_' + Math.random().toString(36).substr(2, 4),
                        email,
                        password,
                        recovery,
                        status: 'ready',
                        sentCount: 0,
                        lastUsed: null,
                        errorMsg: null
                    });
                }
            }
        });
    } else if (req.body.email && req.body.password) {
        const email = req.body.email.trim();
        const existingEmails = new Set(accounts.map(a => a.email.toLowerCase()));
        if (!existingEmails.has(email.toLowerCase())) {
            accounts.push({
                id: 'acc_' + Date.now(),
                email,
                password: req.body.password.trim(),
                recovery: req.body.recovery ? req.body.recovery.trim() : '',
                status: 'ready',
                sentCount: 0,
                lastUsed: null,
                errorMsg: null
            });
        }
    }

    writeJson(ACCOUNTS_FILE, accounts);
    res.json({ success: true, count: accounts.length, accounts });
});

app.delete('/api/accounts/:id', (req, res) => {
    let accounts = readJson(ACCOUNTS_FILE, []);
    accounts = accounts.filter(a => a.id !== req.params.id);
    writeJson(ACCOUNTS_FILE, accounts);
    res.json({ success: true, accounts });
});

app.post('/api/accounts/clear', (req, res) => {
    writeJson(ACCOUNTS_FILE, []);
    res.json({ success: true, accounts: [] });
});

app.post('/api/accounts/reset', (req, res) => {
    let accounts = readJson(ACCOUNTS_FILE, []);
    accounts.forEach(a => {
        a.status = 'ready';
        a.errorMsg = null;
    });
    writeJson(ACCOUNTS_FILE, accounts);
    res.json({ success: true, count: accounts.length, accounts });
});

// Leads (Supports pagination, search query, and fallback full array)
app.get('/api/leads', (req, res) => {
    const leads = readJson(LEADS_FILE, []);
    const { page, limit, search } = req.query;

    if (page !== undefined || limit !== undefined || search !== undefined) {
        let filtered = leads;
        if (search && typeof search === 'string' && search.trim()) {
            const q = search.trim().toLowerCase();
            filtered = filtered.filter(l => l.email.toLowerCase().includes(q));
        }
        const p = Math.max(1, parseInt(page) || 1);
        const l = Math.max(1, Math.min(500, parseInt(limit) || 50));
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / l));
        const start = (p - 1) * l;
        const slice = filtered.slice(start, start + l);

        return res.json({
            success: true,
            total,
            totalPages,
            page: p,
            limit: l,
            leads: slice,
            grandTotal: leads.length
        });
    }

    res.json(leads);
});

app.post('/api/leads', (req, res) => {
    const { rawLeads } = req.body;
    let leads = readJson(LEADS_FILE, []);

    if (rawLeads && typeof rawLeads === 'string') {
        const lines = rawLeads.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const existingEmails = new Set(leads.map(l => l.email.toLowerCase()));
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const now = Date.now();
        let addedCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const email = lines[i].split(/[,;\t ]/)[0].trim();
            if (emailRegex.test(email)) {
                const lower = email.toLowerCase();
                if (!existingEmails.has(lower)) {
                    existingEmails.add(lower);
                    leads.push({
                        id: 'lead_' + now + '_' + i + '_' + Math.random().toString(36).substr(2, 4),
                        email,
                        status: 'pending',
                        sentAt: null,
                        accountUsed: null,
                        errorMsg: null
                    });
                    addedCount++;
                }
            }
        }
    }

    writeJson(LEADS_FILE, leads);
    res.json({ success: true, count: leads.length });
});

app.delete('/api/leads/:id', (req, res) => {
    let leads = readJson(LEADS_FILE, []);
    leads = leads.filter(l => l.id !== req.params.id);
    writeJson(LEADS_FILE, leads);
    res.json({ success: true, count: leads.length, leads });
});

app.post('/api/leads/clear', (req, res) => {
    writeJson(LEADS_FILE, []);
    res.json({ success: true, leads: [] });
});

app.post('/api/leads/reset', (req, res) => {
    let leads = readJson(LEADS_FILE, []);
    leads.forEach(l => {
        l.status = 'pending';
        l.sentAt = null;
        l.errorMsg = null;
    });
    writeJson(LEADS_FILE, leads);
    res.json({ success: true, leads });
});

// PDF Upload
app.post('/api/upload-pdf', upload.single('pdf'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No PDF file uploaded.' });
    }
    const filePath = req.file.path;
    const settings = readJson(SETTINGS_FILE, {});
    settings.selectedPdf = filePath;
    writeJson(SETTINGS_FILE, settings);

    res.json({
        success: true,
        filePath,
        fileName: req.file.originalname,
        size: req.file.size
    });
});

// Settings
app.get('/api/settings', (req, res) => {
    const settings = readJson(SETTINGS_FILE, {});
    // List available PDF files in uploads folder
    let pdfFiles = [];
    try {
        pdfFiles = fs.readdirSync(UPLOADS_DIR)
            .filter(f => f.toLowerCase().endsWith('.pdf'))
            .map(f => ({
                fileName: f,
                filePath: path.join(UPLOADS_DIR, f),
                size: fs.statSync(path.join(UPLOADS_DIR, f)).size
            }));
    } catch (e) { }

    res.json({ settings, availablePdfs: pdfFiles });
});

app.post('/api/settings', (req, res) => {
    const current = readJson(SETTINGS_FILE, {});
    const updated = { ...current, ...req.body };
    writeJson(SETTINGS_FILE, updated);
    res.json({ success: true, settings: updated });
});

// Export Leads
app.get('/api/export/leads', (req, res) => {
    const type = req.query.status || 'all';
    let list = [];
    if (type === 'sent') {
        list = readJson(HISTORY_FILE, []);
    } else if (type === 'failed') {
        list = readJson(LEADS_FILE, []).filter(l => l.status === 'failed');
    } else {
        const history = readJson(HISTORY_FILE, []);
        const remaining = readJson(LEADS_FILE, []);
        list = [...history, ...remaining];
    }
    let csv = 'Email,Status,SentAt,AccountUsed,Error\n';
    list.forEach(l => {
        csv += `"${l.email}","${l.status || 'sent'}","${l.sentAt || ''}","${l.accountUsed || ''}","${l.errorMsg || ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=proton_leads_${type}_${Date.now()}.csv`);
    res.send(csv);
});

// Auto-updater endpoints
app.get('/api/update/check', async (req, res) => {
    const info = await autoUpdater.checkForUpdate();
    res.json(info);
});

app.post('/api/update/install', async (req, res) => {
    const { downloadUrl } = req.body;
    if (!downloadUrl) return res.status(400).json({ error: 'Missing downloadUrl' });

    res.json({ success: true, message: 'Downloading update...' });

    // Download and apply in background
    try {
        const tempExe = await autoUpdater.downloadUpdate(downloadUrl, (percent) => {
            broadcast('update_progress', { percent });
        });
        broadcast('update_ready', { message: 'Update downloaded! Restarting...' });
        setTimeout(() => {
            autoUpdater.applyUpdateAndRestart(tempExe);
        }, 1500);
    } catch (err) {
        broadcast('update_error', { message: err.message });
    }
});

// Global crash guards to keep app 100% resilient
process.on('uncaughtException', (err) => {
    console.error('[CRASH GUARD - UNCAUGHT EXCEPTION]', err ? err.stack || err.message : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[CRASH GUARD - UNHANDLED REJECTION]', reason);
});

// Standalone Native Desktop Window Launcher (Chromeless & App-based)
function launchDesktopAppWindow(port) {
    if (process.platform !== 'win32') return;

    const url = `http://localhost:${port}`;
    const edgePaths = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];

    let appExe = null;
    for (const p of [...edgePaths, ...chromePaths]) {
        if (fs.existsSync(p)) {
            appExe = p;
            break;
        }
    }

    if (appExe) {
        const appWindowDir = path.join(process.env.LOCALAPPDATA || process.env.TEMP, 'ProtonDrivePro_AppWindow');
        const appProcess = spawn(appExe, [
            `--app=${url}`,
            `--user-data-dir=${appWindowDir}`,
            '--window-size=1380,880',
            '--window-position=100,50',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-background-networking',
            `--app-id=ProtonDrivePro`
        ], {
            detached: false,
            stdio: 'ignore'
        });

        // When user closes the native app window, terminate background server process
        appProcess.on('exit', () => {
            console.log('\n[DESKTOP] Application window closed by user. Exiting suite...');
            process.exit(0);
        });

        appProcess.on('error', (err) => {
            console.warn('[DESKTOP] App window spawn warning:', err.message);
            exec(`start ${url}`);
        });
    } else {
        exec(`start ${url}`);
    }
}

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  Proton Drive Auto-Share Dashboard is Running!`);
    console.log(`  URL: http://localhost:${PORT}`);
    console.log(`======================================================\n`);

    // Background KeyAuth initialization & auto-login check
    keyAuth.init().then(() => {
        keyAuth.tryAutoLogin().then(res => {
            if (res && res.success) {
                console.log(`[AUTH] License verified for user: ${res.username} (${res.daysLeft} days remaining)`);
            } else {
                console.log(`[AUTH] Access locked. Awaiting administrator approval / user login.`);
            }
        }).catch(() => {});
    }).catch(err => {
        console.error(`[AUTH] KeyAuth connection: ${err.message}`);
    });

    // Launch as standalone native desktop window
    launchDesktopAppWindow(PORT);
});
