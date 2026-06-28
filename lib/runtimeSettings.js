const path = require('path');

function resolveSettingsModulePath(settingsModulePath) {
    const candidates = new Set();

    if (path.isAbsolute(settingsModulePath)) {
        candidates.add(settingsModulePath);
    } else {
        candidates.add(settingsModulePath);
        candidates.add(path.resolve(process.cwd(), settingsModulePath));
        candidates.add(path.resolve(__dirname, '..', settingsModulePath));
        candidates.add(path.resolve(__dirname, settingsModulePath));
    }

    for (const candidate of candidates) {
        try {
            return require.resolve(candidate);
        } catch (_) {}
    }

    throw new Error(`Cannot resolve settings module: ${settingsModulePath}`);
}

function refreshRuntimeSettings(settingsModulePath) {
    const resolvedPath = resolveSettingsModulePath(settingsModulePath);

    const cachedModule = require.cache[resolvedPath];
    const runtimeRef = cachedModule && cachedModule.exports
        ? cachedModule.exports
        : require(resolvedPath);

    delete require.cache[resolvedPath];
    const latest = require(resolvedPath);

    if (runtimeRef && typeof runtimeRef === 'object') {
        for (const key of Object.keys(runtimeRef)) {
            delete runtimeRef[key];
        }
        Object.assign(runtimeRef, latest);
    }

    if (require.cache[resolvedPath]) {
        require.cache[resolvedPath].exports = runtimeRef;
    }

    return runtimeRef;
}

function getCurrentSettings(settingsModulePath) {
    const resolvedPath = resolveSettingsModulePath(settingsModulePath);
    const cachedModule = require.cache[resolvedPath];
    if (cachedModule && cachedModule.exports) {
        return cachedModule.exports;
    }
    return require(resolvedPath);
}

module.exports = {
    refreshRuntimeSettings,
    getCurrentSettings,
};
