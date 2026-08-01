const { execFileSync } = require('child_process');

const POWERSHELL_EXTRACT_COMMAND = [
    'Expand-Archive',
    '-Force',
    '-LiteralPath',
    '$env:RISU_UPDATE_ARCHIVE',
    '-DestinationPath',
    '$env:RISU_UPDATE_EXTRACT_DIR',
].join(' ');

function extractUpdateArchive(archivePath, extractDir, options = {}) {
    const platform = options.platform || process.platform;
    const run = options.execFileSync || execFileSync;
    const commandOptions = { timeout: 300000 };

    if (platform === 'win32') {
        try {
            run('tar', ['-xf', archivePath, '-C', extractDir], commandOptions);
        } catch {
            run('powershell', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_EXTRACT_COMMAND], {
                ...commandOptions,
                env: {
                    ...process.env,
                    RISU_UPDATE_ARCHIVE: archivePath,
                    RISU_UPDATE_EXTRACT_DIR: extractDir,
                },
            });
        }
        return;
    }

    run('tar', ['-xzf', archivePath, '-C', extractDir], commandOptions);
}

module.exports = { extractUpdateArchive };
