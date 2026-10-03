/** `prepare-web.mjs` 的类型（用例从 TS 里调它）。 */
export declare const BRIDGE_FILE: string;
export declare function injectBridge(html: string): string;
export declare function bundleBridge(): Promise<string>;
export declare function prepareWeb(options?: {
  webDist?: string;
  out?: string;
}): Promise<{ out: string }>;
