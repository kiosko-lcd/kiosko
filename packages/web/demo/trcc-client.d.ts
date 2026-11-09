// Type-checking only (tsconfig.demo.json): @loksly/trcc-client sends Node
// Buffers with Node's fetch, which the DOM lib's fetch types reject. The
// demo never drives a panel, so the client is typed loosely here.
type Fn = (...args: any[]) => any;
export type TrccOptions = any;
export declare const connectPanel: Fn, detectPanel: Fn, sendFrame: Fn, serverAlive: Fn;
export declare const pinFrame: (o: TrccOptions, key: string, seconds: number, log: (m: string) => void) => () => void;
