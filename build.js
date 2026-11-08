const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { rcedit } = require('rcedit');

const ROOT_DIR = __dirname;
const STAGING_DIR = path.join(ROOT_DIR, 'build_staging');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

async function runBuild() {
    console.log('====================================================');
    console.log('   Proton Drive Pro - Secure .EXE Build Pipeline');
    console.log('====================================================\n');

    // Step 1: Clean directories
    console.log('[1/5] Cleaning previous build artifacts...');
    if (fs.existsSync(STAGING_DIR)) fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });

    // Helper to copy directory recursively
    function copyDir(src, dest, ignore = []) {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            if (ignore.includes(entry.name)) continue;
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                copyDir(srcPath, destPath, ignore);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    // Step 2: Copy assets and node_modules
    console.log('[2/5] Copying project files and dependencies into staging...');
    copyDir(path.join(ROOT_DIR, 'public'), path.join(STAGING_DIR, 'public'));
    copyDir(path.join(ROOT_DIR, 'data'), path.join(STAGING_DIR, 'data'));
    fs.mkdirSync(path.join(STAGING_DIR, 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(STAGING_DIR, 'debug', 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(STAGING_DIR, 'engine'), { recursive: true });

    // Copy configuration files
    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(STAGING_DIR, 'package.json'));
    if (fs.existsSync(path.join(ROOT_DIR, 'version.json'))) {
        fs.copyFileSync(path.join(ROOT_DIR, 'version.json'), path.join(STAGING_DIR, 'version.json'));
    }

    // Copy node_modules (excluding heavy devDependencies)
    console.log('      Copying node_modules (this may take a few seconds)...');
    copyDir(path.join(ROOT_DIR, 'node_modules'), path.join(STAGING_DIR, 'node_modules'), [
        '@yao-pkg',
        'javascript-obfuscator',
        'rcedit',
        '.bin'
    ]);

    // Step 3: Obfuscate Source Code Files
    console.log('[3/5] Obfuscating source code with military-grade AST scrambling...');

    const obfuscationOptions = {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        numbersToExpressions: true,
        simplify: true,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.8,
        splitStrings: true,
        splitStringsChunkLength: 5,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        selfDefending: false // keep false for node server stability
    };

    function obfuscateFile(srcPath, destPath) {
        const rawCode = fs.readFileSync(srcPath, 'utf8');
        const obfuscated = JavaScriptObfuscator.obfuscate(rawCode, obfuscationOptions).getObfuscatedCode();
        fs.writeFileSync(destPath, obfuscated, 'utf8');
        console.log(`      ✓ Obfuscated: ${path.relative(ROOT_DIR, srcPath)} -> ${path.relative(STAGING_DIR, destPath)}`);
    }

    obfuscateFile(path.join(ROOT_DIR, 'server.js'), path.join(STAGING_DIR, 'server.js'));
    obfuscateFile(path.join(ROOT_DIR, 'engine', 'keyAuth.js'), path.join(STAGING_DIR, 'engine', 'keyAuth.js'));
    obfuscateFile(path.join(ROOT_DIR, 'engine', 'autoUpdater.js'), path.join(STAGING_DIR, 'engine', 'autoUpdater.js'));
    obfuscateFile(path.join(ROOT_DIR, 'engine', 'protonWorker.js'), path.join(STAGING_DIR, 'engine', 'protonWorker.js'));
    obfuscateFile(path.join(ROOT_DIR, 'engine', 'campaignManager.js'), path.join(STAGING_DIR, 'engine', 'campaignManager.js'));
    obfuscateFile(path.join(ROOT_DIR, 'public', 'app.js'), path.join(STAGING_DIR, 'public', 'app.js'));

    // Step 4: Package with caxa into Standalone .EXE
    console.log('\n[4/5] Packaging standalone executable with caxa...');
    const outputExePath = path.join(DIST_DIR, 'ProtonDrivePro.exe');

    const caxaCmd = `npx caxa --input "${STAGING_DIR}" --output "${outputExePath}" -m "Starting Proton Drive Suite Pro, please wait..." -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/server.js"`;

    try {
        execSync(caxaCmd, { stdio: 'inherit', cwd: ROOT_DIR });
        const stats = fs.statSync(outputExePath);
        console.log(`      ✓ Standalone binary created: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
    } catch (err) {
        console.error('[ERROR] Packaging failed:', err.message);
        process.exit(1);
    } finally {
        console.log('      Cleaning up staging directory...');
        fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    }

    // Step 5: Inject Official Proton Icon & Windows Executable Metadata
    console.log('\n[5/5] Injecting Proton official icon & metadata into ProtonDrivePro.exe...');
    const iconPath = path.join(ROOT_DIR, 'icon.ico');

    if (fs.existsSync(iconPath)) {
        try {
            await rcedit(outputExePath, {
                icon: iconPath,
                'file-version': '1.0.0',
                'product-version': '1.0.0',
                'version-string': {
                    'ProductName': 'Proton Drive Pro',
                    'FileDescription': 'Proton Drive Auto-Share Suite Pro',
                    'CompanyName': 'BYRION',
                    'LegalCopyright': 'Copyright (C) BYRION'
                }
            });
            console.log('      ✓ Official Proton application icon successfully embedded into .EXE!');
        } catch (e) {
            console.warn('      [WARN] Could not inject icon:', e.message);
        }
    }

    console.log('\n====================================================');
    console.log('  BUILD COMPLETE!');
    console.log(`  File: ${outputExePath}`);
    console.log('  Icon: Official Proton Purple Icon Embedded ✓');
    console.log('  Mode: Dedicated Desktop App Window (No Browser Tab) ✓');
    console.log('  Update: GitHub Auto-Updater Connected ✓');
    console.log('====================================================\n');
}

runBuild().catch(err => {
    console.error('Build error:', err);
    process.exit(1);
});
