'use strict';

const { parseRam, sanitizeRam, ramOptionsFor, ramLabel, RAM_OPTIONS } = require('../src/shared/ram');
const { resolveHeap, ramFromArgv, softMaxHeapMb, FALLBACK_HEAP } = require('../src/main/launch');
const { makeLog } = require('./helpers');

describe('memory values', () => {
    test.each([
        ['512m', '512m', 512],
        ['1024M', '1024m', 1024],
        ['1g', '1g', 1024],
        ['2G', '2g', 2048],
        ['1.5g', '1.5g', 1536],
        ['  4g  ', '4g', 4096]
    ])('accepts %p', (input, value, mb) => {
        expect(parseRam(input)).toMatchObject({ value, mb });
    });

    test.each(['1k', '1gb', '-1g', '0g', '0m', '', 'g', '1 g', 'abc'])('rejects %p', (input) => {
        expect(parseRam(input)).toBeNull();
    });

    test.each([null, undefined, 1024, {}, []])('rejects non-strings (%p)', (input) => {
        expect(parseRam(input)).toBeNull();
    });

    test('the sanitiser falls back to 1g', () => {
        expect(sanitizeRam('nonsense')).toBe('1g');
        expect(sanitizeRam(' 2G ')).toBe('2g');
    });

    test('offers the six sizes and never 256 MB', () => {
        expect(RAM_OPTIONS.map((option) => option.value)).toEqual(['512m', '1g', '2g', '4g', '6g', '8g']);
    });

    test('a custom stored value survives and appears as an extra option', () => {
        const { value, options } = ramOptionsFor('3g');
        expect(value).toBe('3g');
        expect(options.find((option) => option.value === '3g').label).toBe('3 GB');
        expect(options.map((option) => option.value)).toEqual(['512m', '1g', '2g', '3g', '4g', '6g', '8g']);
        expect(ramLabel('768m')).toBe('768 MB');
    });

    test('an invalid stored value becomes 1g without adding options', () => {
        const { value, options } = ramOptionsFor('lots');
        expect(value).toBe('1g');
        expect(options).toHaveLength(6);
    });
});

describe('heap resolution', () => {
    test('--ram launcher argument in both forms', () => {
        expect(ramFromArgv(['electron', '.', '--ram', '2g'])).toBe('2g');
        expect(ramFromArgv(['electron', '.', '--ram=4g'])).toBe('4g');
        expect(ramFromArgv(['electron', '.', '--ram'])).toBeNull();
        expect(ramFromArgv(['electron', '.', '--ram='])).toBeNull();
        expect(ramFromArgv(['electron', '.'])).toBeNull();
    });

    test('a preference overrides the command line value', () => {
        const log = makeLog();
        expect(resolveHeap('2g', '4g', log)).toMatchObject({ xms: '2g', xmx: '2g', heapMb: 2048 });
        expect(log.lines).toHaveLength(0);
    });

    test('an invalid preference falls back to the command line with a warning', () => {
        const log = makeLog();
        expect(resolveHeap('huge', '4g', log)).toMatchObject({ xms: '4g', xmx: '4g', heapMb: 4096 });
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
    });

    test('with nothing valid the fixed default is used', () => {
        expect(resolveHeap('huge', null, makeLog())).toMatchObject(FALLBACK_HEAP);
        expect(resolveHeap(undefined, 'nope', makeLog())).toMatchObject({ xms: '512m', xmx: '600m', heapMb: 600 });
    });

    test.each([
        ['1.0g', '1g'],
        ['01g', '1g'],
        [' 2G ', '2g'],
        ['1024M', '1024m'],
        ['0512m', '512m'],
        ['1.5g', '1536m'],
        ['0.5g', '512m'],
        ['700.9m', '700m']
    ])('the JVM value for %p is %p', (input, expected) => {
        const heap = resolveHeap(input, null, makeLog());
        expect(heap.xms).toBe(expected);
        expect(heap.xmx).toBe(expected);
    });

    test('decimal sizes are passed to the JVM as whole megabytes', () => {
        expect(resolveHeap('1.5g', null, makeLog())).toMatchObject({ xms: '1536m', xmx: '1536m', heapMb: 1536 });
    });

    test.each([
        ['512m', 500],
        ['1g', 500],
        ['2g', 500],
        ['4g', 500],
        ['6g', 500],
        ['8g', 500]
    ])('SoftMaxHeapSize for %s is %i', (ram, expected) => {
        const heap = resolveHeap(ram, null, makeLog());
        expect(softMaxHeapMb(heap.heapMb)).toBe(expected);
        expect(softMaxHeapMb(heap.heapMb)).toBeLessThanOrEqual(heap.heapMb);
    });

    test('SoftMaxHeapSize never exceeds a small heap and is 500 when unknown', () => {
        expect(softMaxHeapMb(300)).toBe(300);
        expect(softMaxHeapMb(undefined)).toBe(500);
        expect(softMaxHeapMb(600)).toBe(500);
    });
});
