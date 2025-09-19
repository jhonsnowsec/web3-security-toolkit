import BN from "bn.js";
import util from "node:util";
import Web3 from "web3";

export type BNish = BN | number | string;

export type Nullable<T> = T | null | undefined;

export type Dict<T> = { [key: string]: T };

export type AnyFunction<R = any> = (...args: any[]) => R;       // eslint-disable-line @typescript-eslint/no-explicit-any

export type ConstructorFor<T> = { new(...args: any[]): T };    // eslint-disable-line @typescript-eslint/no-explicit-any

export const BN_ZERO = Web3.utils.toBN(0);
export const BN_ONE = Web3.utils.toBN(1);
export const BN_TEN = Web3.utils.toBN(10);

export const MAX_UINT256 = BN_ONE.shln(256).sub(BN_ONE);

export const MAX_BIPS = 10_000;

export const MINUTES = 60;
export const HOURS = 60 * MINUTES;
export const DAYS = 24 * HOURS;
export const WEEKS = 7 * DAYS;
export const YEARS = 365 * DAYS;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Asynchronously wait `ms` milliseconds.
 */
export function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(() => resolve(), ms));
}

/**
 * Return system time as timestamp (seconds since 1.1.1970).
 */
export function systemTimestamp() {
    return Math.round(new Date().getTime() / 1000);
}

/**
 * Return latest block timestamp as number (seconds since 1.1.1970).
 */
export async function latestBlockTimestamp() {
    const latestBlock = await web3.eth.getBlock('latest');
    return Number(latestBlock.timestamp);
}

/**
 * Like Array.map but for JavaScript objects.
 */
export function objectMap<T, R>(obj: { [key: string]: T }, func: (x: T) => R): { [key: string]: R } {
    const result: { [key: string]: R } = {};
    for (const key of Object.keys(obj)) {
        result[key] = func(obj[key]);
    }
    return result;
}

/**
 * Check if value is non-null.
 * Useful in array.filter, to return array of non-nullable types.
 */
export function isNotNull<T>(x: T): x is NonNullable<T> {
    return x != null;
}

/**
 * Check if value is non-null and throw otherwise.
 * Returns guaranteed non-null value.
 */
export function requireNotNull<T>(x: T, errorMessage?: string): NonNullable<T> {
    if (x != null) return x;
    throw new Error(errorMessage ?? "Value is null or undefined");
}

/**
 * Helper wrapper to convert number to BN
 * @param x number expressed in any reasonable type
 * @returns same number as BN
 */
export function toBN(x: BNish): BN {
    if (BN.isBN(x)) return x;
    return Web3.utils.toBN(x);
}

/**
 * Helper wrapper to convert BN, BigNumber or plain string to number. May lose precision, so use it for tests only.
 * @param x number expressed in any reasonable type
 * @returns same number as Number
 */
export function toNumber(x: BNish) {
    if (typeof x === 'number') return x;
    return Number(x);
}

// return String(Math.round(x * 10^exponent)), but sets places below float precision to zero instead of some random digits
export function toStringExp(x: number | string, exponent: number): string {
    let xstr: string;
    if (typeof x === 'number') {
        const significantDecimals = x !== 0 ? Math.max(0, 14 - Math.floor(Math.log10(x))) : 0;
        const decimals = Math.min(exponent, significantDecimals);
        xstr = x.toFixed(decimals);
    } else {
        if (!/\d+(\.\d+)?/.test(x)) throw new Error("toStringExp: invalid number string");
        xstr = x;
    }
    const dot = xstr.indexOf('.');
    const mantissa = dot >= 0 ? xstr.slice(0, dot) + xstr.slice(dot + 1) : xstr;
    const precision = dot >= 0 ? xstr.length - (dot + 1) : 0;
    if (precision === exponent) return mantissa;
    if (exponent < precision) throw new Error("toStringExp: loss of precision");
    const zeros = Array.from({ length: exponent - precision }, () => '0').join('');   // trailing zeros
    return mantissa + zeros;
}

// return BN(x * 10^exponent)
export function toBNExp(x: number | string, exponent: number): BN {
    return toBN(toStringExp(x, exponent));
}

// convert NAT amount to base units (wei)
export function toWei(amount: number | string) {
    return toBNExp(amount, 18);
}

/**
 * Format large number in more readable format, using 'fixed-exponential' format, with 'e+18' suffix for very large numbers.
 * (This makes them easy to visually detect bigger/smaller numbers.)
 */
export function formatBN(x: BNish, maxDecimals: number = 3) {
    const xs = x.toString();
    if (xs.length >= 18) {
        const decpos = xs.length - 18;
        let xint = xs.slice(0, decpos);
        if (xint === '') xint = '0';
        let xfrac = xs.slice(decpos).replace(/0+$/, '').slice(0, maxDecimals);
        if (xfrac !== '') xfrac = '.' + xfrac;
        return groupIntegerDigits(xint) + xfrac + 'e+18';
    } else {
        return groupIntegerDigits(xs);
    }
}

/**
 * Put '_' characters between 3-digit groups in integer part of a number.
 */
export function groupIntegerDigits(x: string) {
    let startp = x.indexOf('.');
    if (startp < 0) startp = x.length;
    const endp = x[0] === '-' ? 1 : 0;
    for (let p = startp - 3; p > endp; p -= 3) {
        x = x.slice(0, p) + '_' + x.slice(p);
    }
    return x;
}

/**
 * Like `a.muln(b)`, but while muln actualy works with non-integer numbers, it is very imprecise,
 * i.e. `BN(1e30).muln(1e-20) = BN(0)` and `BN(1e10).muln(0.15) = BN(1476511897)`.
 * This function gives as exact results as possible.
 */
export function mulDecimal(a: BN, b: number) {
    if (Math.round(b) === b && Math.abs(b) < 1e16) {
        return a.mul(toBN(b));
    }
    const exp = 15 - Math.ceil(Math.log10(b));
    const bm = Math.round(b * (10 ** exp));
    const m = a.mul(toBN(bm));
    return exp >= 0 ? m.div(exp10(exp)) : m.mul(exp10(-exp));
}

/**
 * Convert value to hex with 0x prefix and optional padding.
 */
export function toHex(x: BNish, padToBytes?: number) {
    if (padToBytes && padToBytes > 0) {
        return Web3.utils.leftPad(Web3.utils.toHex(x), padToBytes * 2);
    }
    return Web3.utils.toHex(x);
}

/**
 * Generate random EVM addresss.
 */
export function randomAddress() {
    return Web3.utils.toChecksumAddress(Web3.utils.randomHex(20))
}

/**
 * Convert object to subclass with type check.
 */
export function checkedCast<S, T extends S>(obj: S, cls: ConstructorFor<T>): T {
    if (obj instanceof cls) return obj;
    throw new Error(`object not instance of ${cls.name}`);
}

/**
 * Functional style try...catch.
 */
export function tryCatch<T>(body: () => T): T | undefined;
export function tryCatch<T>(body: () => T, errorHandler: (err: unknown) => T): T;
export function tryCatch<T>(body: () => T, errorHandler?: (err: unknown) => T) {
    try {
        return body();
    } catch (err) {
        return errorHandler?.(err);
    }
}

/**
 * Run `func` in parallel. Allows nicer code in case func is an async lambda.
 */
export function runAsync(func: () => Promise<void>) {
    void func()
        .catch(e => { console.error(e); });
}

/**
 * Get value of key `key` for map. If it doesn't exists, create new value, add it to the map and return it.
 */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, create: (key: K) => V): V {
    if (map.has(key)) {
        return map.get(key)!;
    }
    const value = create(key);
    map.set(key, value);
    return value;
}

/**
 * Get value of key `key` for map. If it doesn't exists, create new value, add it to the map and return it.
 */
export async function getOrCreateAsync<K, V>(map: Map<K, V>, key: K, create: (key: K) => Promise<V>): Promise<V> {
    if (map.has(key)) {
        return map.get(key)!;
    }
    const value = await create(key);
    map.set(key, value);
    return value;
}

/**
 * Add a value to "multimap" - a map where there are several values for each key.
 */
export function multimapAdd<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
    let set = map.get(key);
    if (set === undefined) {
        set = new Set();
        map.set(key, set);
    }
    set.add(value);
}

/**
 * Remove a value from "multimap" - a map where there are several values for each key.
 */
export function multimapDelete<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(value);
    if (set.size === 0) {
        map.delete(key);
    }
}

/**
 * Returns last element of array or `undefined` if array is empty.
 */
export function last<T>(array: T[]): T | undefined {
    return array.length > 0 ? array[array.length - 1] : undefined;
}

/**
 * Like Array.reduce, but for any Iterable.
 */
export function reduce<T, R>(list: Iterable<T>, initialValue: R, operation: (a: R, x: T) => R) {
    let result = initialValue;
    for (const x of list) {
        result = operation(result, x);
    }
    return result;
}

/**
 * Sum all values in an Array or Iterable of numbers.
 */
export function sum<T>(list: Iterable<T>, elementValue: (x: T) => number): number;
export function sum(list: Iterable<number>): number;
export function sum<T>(list: Iterable<T>, elementValue: (x: T) => number = identity) {
    return reduce(list, 0, (a, x) => a + elementValue(x));
}

/**
 * Sum all values in an Array or Iterable of BNs.
 */
export function sumBN<T>(list: Iterable<T>, elementValue: (x: T) => BN): BN;
export function sumBN(list: Iterable<BN>): BN;
export function sumBN<T>(list: Iterable<T>, elementValue: (x: T) => BN = identity) {
    return reduce(list, BN_ZERO, (a, x) => a.add(elementValue(x)));
}

/**
 * Return the maximum of two or more BN values.
 */
export function maxBN(first: BN, ...rest: BN[]) {
    let result = first;
    for (const x of rest) {
        if (x.gt(result)) result = x;
    }
    return result;
}

/**
 * Return the minimum of two or more BN values.
 */
export function minBN(first: BN, ...rest: BN[]) {
    let result = first;
    for (const x of rest) {
        if (x.lt(result)) result = x;
    }
    return result;
}

/**
 * A promise that can be resolved/rejected "from the outside" by calling future.resolve/reject.
 */
export class Future<T> {
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (error: unknown) => void;
    promise = new Promise<T>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });
}

/**
 * Return a copy of list, sorted by comparisonKey.
 */
export function sorted<T, K>(list: Iterable<T>, comparisonKey: (e: T) => K, compare?: (x: K, y: K) => number): T[];
export function sorted<T>(list: Iterable<T>): T[];
export function sorted<T, K>(list: Iterable<T>, comparisonKey: (e: T) => K = identity, compare: (x: K, y: K) => number = naturalCompare) {
    const array = Array.from(list);
    array.sort((a, b) => {
        const aKey = comparisonKey(a), bKey = comparisonKey(b);
        return compare(aKey, bKey);
    });
    return array;
}

function identity<T, R>(x: T): R {  // only actually used for T == R
    return x as unknown as R;
}

function naturalCompare<T>(x: T, y: T): number {
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
}

export interface PromiseValue<T> {
    resolved: boolean;
    value?: T;
}

/**
 * Return a struct whose `value` field is set when promise id fullfiled.
 */
export function promiseValue<T>(promise: Promise<T>): PromiseValue<T> {
    const result: PromiseValue<T> = { resolved: false };
    void promise.then(value => {
        result.resolved = true;
        result.value = value;
    });
    return result;
}

// Error handling

export function fail(messageOrError: string | Error): never {
    if (typeof messageOrError === 'string') {
        throw new Error(messageOrError);
    }
    throw messageOrError;
}

export function filterStackTrace(error: unknown) {
    const stack = String((error as Error)?.stack || error);
    let lines = stack.split('\n');
    lines = lines.filter(l => !l.startsWith('    at') || /\.(sol|ts):/.test(l));
    return lines.join('\n');
}

export function reportError(error: unknown) {
    console.error(filterStackTrace(error));
}

// either (part of) error message or an error constructor
export type SimpleErrorFilter = string | ConstructorFor<Error>;
export type ErrorFilter = SimpleErrorFilter | { error: SimpleErrorFilter, when: boolean };

function simpleErrorMatch(error: unknown, message: string, expectedError: SimpleErrorFilter) {
    if (typeof expectedError === 'string') {
        if (message.includes(expectedError)) return true;
    } else {
        if (error instanceof expectedError) return true;
    }
    return false;
}

export function errorIncluded(error: unknown, expectedErrors: ErrorFilter[]) {
    const message = String((error as Error)?.message ?? '');
    for (const expectedErr of expectedErrors) {
        const expectedErrMatches = typeof expectedErr === 'object' && 'when' in expectedErr
            ? expectedErr.when && simpleErrorMatch(error, message, expectedErr.error)
            : simpleErrorMatch(error, message, expectedErr);
        if (expectedErrMatches) return true;
    }
    return false;
}

export function expectErrors(error: unknown, expectedErrors: ErrorFilter[]): undefined {
    if (errorIncluded(error, expectedErrors)) return;
    throw error;    // unexpected error
}

// Convert number or percentage string "x%" to BIPS.
export function toBIPS(x: number | string) {
    if (typeof x === 'string' && x.endsWith('%')) {
        return toBNExp(x.slice(0, x.length - 1), 2);    // x is in percent, only multiply by 100
    } else {
        return toBNExp(x, 4);
    }
}

// Calculate 10 ** n as BN.
export function exp10(n: BNish) {
    return BN_TEN.pow(toBN(n));
}

export function isBNLike(value: unknown): value is BNish {
    return BN.isBN(value) || (typeof value === 'string' && /^\d+$/.test(value));
}

type DeepFormatOptions = {
    allowNumericKeys?: boolean;
    maxDecimals?: number;
};

/**
 * Some Web3 results are union of array and struct so console.log prints them as array.
 * This function converts it to struct nad also formats values.
 */
export function deepFormat(value: unknown, options?: DeepFormatOptions): unknown {
    const opts = { allowNumericKeys: false, maxDecimals: 3, ...options };
    function isNumberLike(key: string | number) {
        return typeof key === 'number' || /^\d+$/.test(key);
    }
    if (isBNLike(value)) {
        return formatBN(value, opts.maxDecimals);
    } else if (Array.isArray(value)) {
        const structEntries = Object.entries(value)
            .filter(([key, val]) => !isNumberLike(key));
        if (structEntries.length > 0 && structEntries.length >= value.length) {
            const formattedEntries = structEntries.map(([key, val]) => [key, deepFormat(val, opts)]);
            return Object.fromEntries(formattedEntries);
        } else {
            return value.map(v => deepFormat(v, opts));
        }
    } else if (typeof value === 'object' && value != null) {
        const formattedEntries = Object.entries(value)
            .filter(([key, val]) => opts.allowNumericKeys || !isNumberLike(key))
            .map(([key, val]) => [key, deepFormat(val, opts)]);
        return Object.fromEntries(formattedEntries);
    } else {
        return value;
    }
}

/**
 * Print `name = value` pairs for a dict of format `{name: value, name: value, ...}`
 */
export function trace(items: Record<string, unknown>, options?: DeepFormatOptions) {
    for (const [key, value] of Object.entries(items)) {
        const serialize = typeof value === 'object' && value != null && (value.constructor === Array || value.constructor === Object);
        const valueS = serialize ? JSON.stringify(deepFormat(value, options)) : deepFormat(value, options);
        console.log(`${key} = ${valueS}`);
    }
}

/**
 * Improve console.log display by pretty-printing BN end expanding objects.
 * @param inspectDepth the depth objects in console.log will be expanded
 */
export function improveConsoleLog(inspectDepth: number = 10) {
    function fixBNOutput(BN: any) {                                 // eslint-disable-line @typescript-eslint/no-explicit-any
        BN.prototype[util.inspect.custom] = function (this: BN) {   // eslint-disable-line @typescript-eslint/no-unsafe-member-access
            return `BN(${this.toString(10)})`;
        };
    }
    fixBNOutput(BN);
    fixBNOutput(toBN(0).constructor);   // if web3 uses a different version
    util.inspect.defaultOptions.depth = inspectDepth;
}

type InterfaceDef = AbiItem[] | Truffle.Contract<unknown> | string;

/**
 * Get ERC-165 interface id from interface ABI.
 */
export function erc165InterfaceId(mainInterface: InterfaceDef, inheritedInterfaces: InterfaceDef[] = []) {
    function extractAbi(interfaceDef: InterfaceDef) {
        if (Array.isArray(interfaceDef)) {
            return interfaceDef;
        } else if (typeof interfaceDef === "string") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
            return contractMetadata(artifacts.require(interfaceDef as any)).abi;
        } else {
            return contractMetadata(interfaceDef).abi;
        }
    }
    let result = BN_ZERO;
    const inheritesSigs = new Set(inheritedInterfaces
        .map(extractAbi)
        .flat(1)
        .filter(it => it.type === 'function')
        .map(it => web3.eth.abi.encodeFunctionSignature(it)));
    for (const item of extractAbi(mainInterface)) {
        if (item.type !== 'function') continue;
        const signature = web3.eth.abi.encodeFunctionSignature(item);
        if (inheritesSigs.has(signature)) continue;
        result = result.xor(web3.utils.toBN(signature));
    }
    return '0x' + result.toString(16, 8);
}

export function contractMetadata(contract: Truffle.Contract<unknown>): { contractName: string, abi: AbiItem[] } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (contract as any)._json;
}

/**
 * ABI encode method call, typesafe when used with typechain.
 */
export function abiEncodeCall<I extends Truffle.ContractInstance>(instance: I, call: (inst: I) => Promise<unknown>): string {
    // call in ContractInstance returns a promise, but in contract.methods it returns an object which contains (among others) encodeABI method, so the cast below is safe
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return (call as any)(instance.contract.methods).encodeABI() as string;
}

/**
 * Calculate ERC-7201 slot number from namespace, as in https://eips.ethereum.org/EIPS/eip-7201.
 * @param namespace the namespace, e.g. 'fasset.utils.Something'
 * @returns 0x-prefixed 32-byte hex encoded string
 */
export function erc7201slot(namespace: string): string {
    const inner = toHex(toBN(Web3.utils.keccak256(Web3.utils.asciiToHex(namespace))).subn(1), 32);
    const mask = toBN(0xff).notn(256);
    return toHex(toBN(Web3.utils.keccak256(inner)).and(mask), 32);
}