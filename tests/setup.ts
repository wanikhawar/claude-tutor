// Plugin code uses window timers (for Obsidian's popout windows). Node-environment tests have no window.
if (typeof window === "undefined") Object.assign(globalThis, { window: globalThis });
