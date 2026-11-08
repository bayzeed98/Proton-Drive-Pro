const https = require('https');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ==========================================
// KeyAuth Application Credentials
// ==========================================
const APP_NAME = "Proton Drive Pro";
const OWNER_ID = "NaNRh8VuB0";
const APP_SECRET = "8a54a54872a839bf677b69eace914b093fb9721174988d9d058f590bc5fb0667";
const APP_VERSION = "1.0";
const BASE_URL = "https://keyauth.win/api/1.2/";

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTH_CONFIG_FILE = path.join(DATA_DIR, 'auth_config.json');

const APPDATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'ProtonDrivePro') : path.join(os.homedir(), '.protondrive');
const APPDATA_AUTH_FILE = path.join(APPDATA_DIR, 'auth_config.json');

function getHwid() {
    try {
        const out = execSync('wmic csproduct get uuid', { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).toString();
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length > 1 && lines[1]) return lines[1];
    } catch (e) { }

    try {
        const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
        if (out) return out;
    } catch (e) { }

    return `${os.hostname()}-${os.platform()}-${os.arch()}`;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 15000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Invalid response from authentication server (${body.substring(0, 100)})`));
                }
            });
        }).on('error', (err) => {
            reject(new Error(`Cannot connect to authentication server: ${err.message}`));
        }).on('timeout', function() {
            this.destroy();
            reject(new Error('Authentication server request timed out.'));
        });
    });
}

class KeyAuthService {
    constructor() {
        this.sessionId = null;
        this.hwid = getHwid();
        this.isAuthenticated = false;
        this.currentUser = null;
        this.subscriptionDaysLeft = 0;
        this.initPromise = null;
    }

    async init() {
        if (this.sessionId) return true;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            const url = `${BASE_URL}?type=init&name=${encodeURIComponent(APP_NAME)}&ownerid=${OWNER_ID}&secret=${APP_SECRET}&version=${APP_VERSION}`;
            const res = await requestJson(url);
            if (res && res.success) {
                this.sessionId = res.sessionid;
                return true;
            } else {
                throw new Error((res && res.message) || 'Failed to initialize KeyAuth server.');
            }
        })();

        return this.initPromise;
    }

    async login(username, password) {
        if (!username || !password) {
            throw new Error('Username and password are required.');
        }

        await this.init();

        const url = `${BASE_URL}?type=login&username=${encodeURIComponent(username)}&pass=${encodeURIComponent(password)}&hwid=${encodeURIComponent(this.hwid)}&sessionid=${this.sessionId}&name=${encodeURIComponent(APP_NAME)}&ownerid=${OWNER_ID}`;
        const res = await requestJson(url);

        if (res && res.success) {
            const info = res.info || {};
            let daysLeft = 'N/A';
            if (info.subscriptions && info.subscriptions.length > 0) {
                const timeLeftSec = parseInt(info.subscriptions[0].timeleft) || 0;
                daysLeft = Math.floor(timeLeftSec / 86400);
            }

            this.isAuthenticated = true;
            this.currentUser = username;
            this.subscriptionDaysLeft = daysLeft;

            // Save credentials locally for auto-login
            this.saveAuthConfig({
                username,
                password,
                hwid: this.hwid,
                daysLeft,
                lastLogin: Date.now()
            });

            return {
                success: true,
                username,
                daysLeft,
                hwid: this.hwid,
                info
            };
        } else {
            this.isAuthenticated = false;
            this.currentUser = null;
            throw new Error((res && res.message) || 'Invalid credentials or access has not been granted by administrator.');
        }
    }

    async tryAutoLogin() {
        const config = this.loadAuthConfig();
        if (config && config.username && config.password) {
            try {
                return await this.login(config.username, config.password);
            } catch (e) {
                // Auto-login failed (credentials changed, HWID reset, or expired)
                this.isAuthenticated = false;
                this.currentUser = null;
                return null;
            }
        }
        return null;
    }

    logout() {
        this.isAuthenticated = false;
        this.currentUser = null;
        this.subscriptionDaysLeft = 0;
        try {
            if (fs.existsSync(AUTH_CONFIG_FILE)) fs.unlinkSync(AUTH_CONFIG_FILE);
        } catch (e) { }
        try {
            if (fs.existsSync(APPDATA_AUTH_FILE)) fs.unlinkSync(APPDATA_AUTH_FILE);
        } catch (e) { }
    }

    getStatus() {
        return {
            authenticated: this.isAuthenticated,
            currentUser: this.currentUser,
            subscriptionDaysLeft: this.subscriptionDaysLeft,
            hwid: this.hwid
        };
    }

    loadAuthConfig() {
        const candidateFiles = [
            AUTH_CONFIG_FILE,
            path.join(process.cwd(), 'data', 'auth_config.json'),
            APPDATA_AUTH_FILE
        ];
        for (const file of candidateFiles) {
            try {
                if (fs.existsSync(file)) {
                    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                    if (data && data.username && data.password) return data;
                }
            } catch (e) { }
        }
        return null;
    }

    saveAuthConfig(data) {
        // Save both locally in project/data and permanently in user AppData
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(AUTH_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) { }

        try {
            if (!fs.existsSync(APPDATA_DIR)) fs.mkdirSync(APPDATA_DIR, { recursive: true });
            fs.writeFileSync(APPDATA_AUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) { }
    }
}

const keyAuthService = new KeyAuthService();
module.exports = keyAuthService;
