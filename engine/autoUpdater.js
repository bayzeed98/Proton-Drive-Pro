const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOCAL_VERSION = require('../package.json').version || '1.0.0';

// GitHub repository details (can be customized via settings or env)
const GITHUB_REPO_OWNER = process.env.GITHUB_OWNER || 'bayzeed98';
const GITHUB_REPO_NAME = process.env.GITHUB_REPO || 'proton-drive-app';
const VERSION_URL = `https://raw.githubusercontent.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/main/version.json`;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, { headers: { 'User-Agent': 'ProtonDrivePro-AutoUpdater' }, timeout: 8000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchJson(res.headers.location));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Update check returned HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid update configuration from server'));
                }
            });
        }).on('error', err => reject(err));
    });
}

function compareVersions(v1, v2) {
    const p1 = (v1 || '0').split('.').map(Number);
    const p2 = (v2 || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const n1 = p1[i] || 0;
        const n2 = p2[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

class AutoUpdater {
    constructor() {
        this.currentVersion = LOCAL_VERSION;
        this.isUpdating = false;
    }

    async checkForUpdate() {
        try {
            const remote = await fetchJson(VERSION_URL);
            const updateAvailable = compareVersions(remote.version, this.currentVersion) > 0;
            return {
                success: true,
                updateAvailable,
                currentVersion: this.currentVersion,
                latestVersion: remote.version,
                changelog: remote.changelog || 'Performance improvements and optimizations.',
                downloadUrl: remote.downloadUrl,
                releaseDate: remote.releaseDate
            };
        } catch (err) {
            return {
                success: false,
                updateAvailable: false,
                currentVersion: this.currentVersion,
                error: err.message
            };
        }
    }

    downloadUpdate(downloadUrl, onProgress) {
        return new Promise((resolve, reject) => {
            const tempDir = process.env.TEMP || os.tmpdir();
            const tempExePath = path.join(tempDir, `ProtonDrivePro_v${Date.now()}.exe`);
            const fileStream = fs.createWriteStream(tempExePath);

            const download = (url) => {
                const client = url.startsWith('https') ? https : http;
                client.get(url, { headers: { 'User-Agent': 'ProtonDrivePro-AutoUpdater' } }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        return download(res.headers.location);
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Download failed with status ${res.statusCode}`));
                    }

                    const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                    let receivedBytes = 0;

                    res.on('data', (chunk) => {
                        receivedBytes += chunk.length;
                        if (totalBytes && onProgress) {
                            const percent = Math.round((receivedBytes / totalBytes) * 100);
                            onProgress(percent);
                        }
                    });

                    res.pipe(fileStream);

                    fileStream.on('finish', () => {
                        fileStream.close(() => resolve(tempExePath));
                    });
                }).on('error', err => {
                    fs.unlink(tempExePath, () => {});
                    reject(err);
                });
            };

            download(downloadUrl);
        });
    }

    applyUpdateAndRestart(newExePath) {
        const currentExePath = process.execPath;
        const currentExeDir = path.dirname(currentExePath);
        const tempDir = process.env.TEMP || os.tmpdir();
        const batchScriptPath = path.join(tempDir, `update_proton_${Date.now()}.bat`);

        // Windows batch script to swap the executable and relaunch
        const batContent = `@echo off
echo Updating Proton Drive Pro to the latest version...
timeout /t 2 /nobreak >nul
:retry
move /y "${newExePath}" "${currentExePath}" >nul 2>&1
if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto retry
)
start "" "${currentExePath}"
del "%~f0"
exit
`;
        fs.writeFileSync(batchScriptPath, batContent, 'utf8');

        // Spawn detached batch script and terminate current process
        const child = spawn('cmd.exe', ['/c', batchScriptPath], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();

        setTimeout(() => {
            process.exit(0);
        }, 500);
    }
}

const autoUpdater = new AutoUpdater();
module.exports = autoUpdater;
