const { globSync, hasMagic } = require ('glob');

// Only the interface used by typescript-estree 8.73.0 is supported. Fail loudly
// if an upstream upgrade starts depending on more of tinyglobby's API.
exports.isDynamicPattern = pattern => hasMagic (pattern, { magicalBraces: true });
exports.globSync = (pattern, options) => {
    const { cwd, ignore, expandDirectories, ...unsupported } = options;
    if (expandDirectories !== false || Object.keys (unsupported).length !== 0) {
        throw new Error ('Unsupported typescript-estree glob options; review tools/lint-glob');
    }
    return globSync (pattern, { cwd, ignore, nodir: true, dot: false, follow: true });
};
