// Loaded by the main process (require) and by the renderer (plain <script>), so it has no imports.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PXRam = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULT_RAM = '1g';

    const RAM_OPTIONS = [
        { value: '512m', label: '512 MB' },
        { value: '1g', label: '1 GB' },
        { value: '2g', label: '2 GB' },
        { value: '4g', label: '4 GB' },
        { value: '6g', label: '6 GB' },
        { value: '8g', label: '8 GB' }
    ];

    // Returns { value, mb, number, unit } for a valid value such as "2g" or "1.5G", otherwise null.
    function parseRam(input) {
        if (typeof input !== 'string') {
            return null;
        }
        const value = input.trim().toLowerCase();
        const match = /^(\d+(?:\.\d+)?)([mg])$/.exec(value);
        if (!match) {
            return null;
        }
        const number = Number(match[1]);
        if (!Number.isFinite(number) || number <= 0) {
            return null;
        }
        const unit = match[2];
        const mb = unit === 'g' ? number * 1024 : number;
        if (mb < 1) {
            return null;
        }
        return { value, mb, number, unit };
    }

    function sanitizeRam(input) {
        const parsed = parseRam(input);
        return parsed ? parsed.value : DEFAULT_RAM;
    }

    function ramLabel(value) {
        const parsed = parseRam(value);
        if (!parsed) {
            return String(value);
        }
        return parsed.number + (parsed.unit === 'g' ? ' GB' : ' MB');
    }

    // The offered options, plus the stored value as an extra option when it is valid but not offered.
    function ramOptionsFor(stored) {
        const value = sanitizeRam(stored);
        const options = RAM_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
        if (!options.some((option) => option.value === value)) {
            options.push({ value, label: ramLabel(value) });
            options.sort((a, b) => parseRam(a.value).mb - parseRam(b.value).mb);
        }
        return { value, options };
    }

    return { DEFAULT_RAM, RAM_OPTIONS, parseRam, sanitizeRam, ramLabel, ramOptionsFor };
});
