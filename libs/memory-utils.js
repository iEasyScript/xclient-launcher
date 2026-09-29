/**
 * Memory configuration utilities for testing
 * Extracted from jar-executor.js for unit testing purposes
 */

const DEFAULT_XMS_VALUE = '512m';
const DEFAULT_XMX_VALUE = '1g';
const DEFAULT_CLIENT_RAM = DEFAULT_XMX_VALUE;

/**
 * Normalizes RAM value to a consistent format
 * @param {string} value - The RAM value to normalize (e.g., "1g", "512m")
 * @returns {Object|null} - Normalized result with mb and normalized string, or null if invalid
 */
function normalizeRamValue(value) {
    if (!value || typeof value !== 'string') return null;

    const trimmed = value.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)([mg])$/);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const unit = match[2];
    const mb = unit === 'g' ? amount * 1024 : amount;

    return { normalized: `${amount}${unit}`, mb };
}

/**
 * Builds memory arguments from a RAM value
 * @param {string} ramValue - The RAM value to parse
 * @param {Object} log - Logger instance
 * @param {string} contextLabel - Context for logging
 * @returns {Object|null} - Memory config with args and normalized value, or null if invalid
 */
function buildMemoryArgsFromRam(ramValue, log, contextLabel) {
    if (!ramValue || typeof ramValue !== 'string') {
        return null;
    }

    const parsed = normalizeRamValue(ramValue);
    if (!parsed) {
        if (contextLabel && log) {
            log.warn(
                `Invalid ${contextLabel} value "${ramValue}". Falling back to default memory settings.`
            );
        }
        return null;
    }

    return {
        args: [`-Xms${parsed.normalized}`, `-Xmx${parsed.normalized}`],
        normalized: parsed.normalized,
        mb: parsed.mb
    };
}

/**
 * Extracts RAM value from command line arguments
 * @param {string[]} argv - Command line arguments array
 * @returns {string|null} - Extracted RAM value or null if not found
 */
function extractRamValue(argv) {
    if (!Array.isArray(argv)) return null;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (typeof arg !== 'string') continue;

        if (arg === '--ram') {
            return argv[i + 1];
        }

        if (arg.startsWith('--ram=')) {
            return arg.slice('--ram='.length);
        }
    }

    return null;
}

/**
 * Creates a selectMemoryArgs function with the given configuration
 * @param {Object} config - Configuration object
 * @param {Object} config.cliMemory - CLI memory configuration
 * @param {Object} config.defaultMemoryConfig - Default memory configuration
 * @param {string} config.defaultMemorySource - Source description for default config
 * @param {Object} config.log - Logger instance
 * @returns {Function} - The selectMemoryArgs function
 */
function createSelectMemoryArgs(config) {
    const { cliMemory, defaultMemoryConfig, defaultMemorySource, log } = config;

    return function selectMemoryArgs(requestedRam) {
        const rawValue =
            typeof requestedRam === 'string'
                ? requestedRam.trim().toLowerCase()
                : '';
        const override = buildMemoryArgsFromRam(
            rawValue,
            log,
            'client RAM preference'
        );

        if (override) {
            return {
                args: override.args,
                source: `client preference (${override.normalized})`
            };
        }

        return {
            args: [...defaultMemoryConfig.args],
            source: defaultMemorySource
        };
    };
}

/**
 * Creates default memory configuration based on CLI args
 * @param {string[]} argv - Command line arguments
 * @param {Object} log - Logger instance
 * @returns {Object} - Configuration object with memory settings
 */
function createDefaultMemoryConfig(argv, log) {
    const cliRamValue = extractRamValue(argv);
    const cliMemory = buildMemoryArgsFromRam(cliRamValue, log, '--ram');
    const defaultMemoryConfig =
        cliMemory ?? {
            args: [`-Xms${DEFAULT_XMS_VALUE}`, `-Xmx${DEFAULT_XMX_VALUE}`],
            normalized: DEFAULT_CLIENT_RAM
        };
    const defaultMemorySource = cliMemory
        ? `CLI --ram (${cliMemory.normalized})`
        : `launcher default (${DEFAULT_CLIENT_RAM})`;

    return {
        cliMemory,
        defaultMemoryConfig,
        defaultMemorySource
    };
}

/** What ZGC aims to stay under, when the heap leaves room for it. */
const SOFT_MAX_HEAP_MB = 500;

/**
 * The ZGC soft maximum for a given heap, in MB.
 *
 * Never larger than the heap it is bounding. The JVM refuses to start when
 * SoftMaxHeapSize exceeds -Xmx, which is what made the 256 MB option fail with
 * "SoftMaxHeapSize must be less than or equal to the maximum heap size"; and a
 * ceiling above the ceiling means nothing anyway.
 *
 * @param {number|null} heapMb the -Xmx in MB, or null when it is not known
 */
function softMaxHeapMb(heapMb) {
    return Number.isFinite(heapMb) && heapMb > 0
        ? Math.min(SOFT_MAX_HEAP_MB, heapMb)
        : SOFT_MAX_HEAP_MB;
}

module.exports = {
    normalizeRamValue,
    buildMemoryArgsFromRam,
    extractRamValue,
    createSelectMemoryArgs,
    createDefaultMemoryConfig,
    DEFAULT_XMS_VALUE,
    DEFAULT_XMX_VALUE,
    DEFAULT_CLIENT_RAM,
    softMaxHeapMb,
    SOFT_MAX_HEAP_MB
};