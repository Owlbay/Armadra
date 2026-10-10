// The part of Claude Code's function-hooks API the Armadra mod uses, written
// by hand for the core's unit test to type-check the generated module
// (apps/desktop/src/core/hook/install/claude-mod/template.test.ts) without a
// Claude Code on the machine. Shapes as Claude Code 2.1.293 declares them;
// the probe (tools/probes/claude-mod-launch.mjs) checks the same module
// against the real declarations the engine writes beside a loaded mod.
//
// Narrower than the real one on purpose: a call the mod starts making that is
// not declared here fails the test, and is added here only after it was read
// off the real declarations of the gate's version (CLAUDE_MODS_MIN).
declare module "claude-code" {
  export type RenderSurface = "terminal" | "desktop" | "mobile" | "vscode";

  export type SessionStartInput = {
    cwd: string;
    surface: RenderSurface | null;
    isInteractive: boolean;
  };

  export type SessionVersion = {
    version: string;
    base?: string;
    builtAt?: string;
  };

  export type HttpInit = {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    auth?: string;
    socketPath?: string;
  };

  export type HttpResponse = {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    text: string;
  };

  export type ProcessRunInit = {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  };

  export type ProcessRunResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
  };

  /** Each plugin's session state, declared by its contract (`hooks/armadra-state.d.ts`). */
  export interface PluginState {}

  export type StateRef<
    P extends keyof PluginState & string,
    K extends keyof PluginState[P] & string,
  > = { readonly plugin: P; readonly key: K };

  export type StateRead<T> = { value: T | undefined; version: number };

  export type StateSetResult = { isSet: boolean; version: number };

  export type Timer = { cancel: () => void };

  export type ToastOptions = { timeoutMs?: number };

  /** A drawn tree: plain data the surface validates. */
  export type RenderElement = {
    readonly type: unknown;
    readonly props: unknown;
  };
  export type RenderNode =
    | RenderElement
    | string
    | number
    | boolean
    | null
    | undefined;

  export type TextProps = {
    color?: string;
    dimColor?: boolean;
    bold?: boolean;
    wrap?:
      | "wrap"
      | "end"
      | "middle"
      | "truncate"
      | "truncate-start"
      | "truncate-middle"
      | "truncate-end";
    children?: unknown;
  };

  export type Elements = {
    Text: (props: TextProps) => RenderElement;
    Box: (props: { children?: unknown }) => RenderElement;
  };

  export type AbovePromptProps = {
    hasSurvey: boolean;
    isWorking: boolean;
    maxRows: number;
    bodyColumns: number;
  };

  export type AbovePromptInput = {
    surface: "terminal" | "desktop";
    component: "AbovePrompt";
    requestId: string;
    props: AbovePromptProps;
  };

  export interface EngineInterface {
    env: { get: (name: string) => Promise<string | undefined> };
    fs: { read: (path: string) => Promise<string> };
    http: {
      fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>;
    };
    process: {
      run: (
        argv: readonly string[],
        init?: ProcessRunInit,
      ) => Promise<ProcessRunResult>;
    };
    clock: {
      sleep: (ms: number) => Promise<void>;
      every: (ms: number, fn: () => void) => Timer;
    };
    session: { version: () => Promise<SessionVersion> };
    state: {
      get: <
        P extends keyof PluginState & string,
        K extends keyof PluginState[P] & string,
      >(
        ref: StateRef<P, K>,
      ) => Promise<StateRead<PluginState[P][K]>>;
      set: <
        P extends keyof PluginState & string,
        K extends keyof PluginState[P] & string,
      >(
        ref: StateRef<P, K>,
        value: PluginState[P][K],
      ) => Promise<StateSetResult>;
    };
    ui: {
      status: (text: string | undefined) => void;
      toast: (text: string, options?: ToastOptions) => void;
      resolve: (e: { surface: "terminal" | "desktop" }) => Elements;
    };
  }

  export interface Next<I, R> {
    (e: I): Promise<R>;
    readonly called: boolean;
  }

  export type Hook<I, R> = (
    $: EngineInterface,
    e: I,
    next: Next<I, R>,
  ) => Promise<R> | R;

  export interface Registration<I, R> {
    catch(handler: Hook<I, R>): void;
  }

  /** The classic events the mod forwards; each `e` is the hook's stdin JSON, PreToolUse's the tool-call envelope. */
  export type ClassicEventName =
    | "classic.SessionStart"
    | "classic.UserPromptSubmit"
    | "classic.PreToolUse"
    | "classic.PostToolUse"
    | "classic.Notification"
    | "classic.Stop"
    | "classic.StopFailure"
    | "classic.SubagentStart"
    | "classic.SubagentStop"
    | "classic.SessionEnd";

  export interface On {
    (
      event: "session.start",
      hook: Hook<SessionStartInput, { cwd: string }>,
    ): Registration<SessionStartInput, { cwd: string }>;
    (
      event: ClassicEventName,
      hook: Hook<Record<string, unknown>, unknown>,
    ): Registration<Record<string, unknown>, unknown>;
    (
      event: "ui.render",
      matcher: { component: "AbovePrompt" },
      hook: Hook<AbovePromptInput, RenderElement>,
    ): Registration<AbovePromptInput, RenderElement>;
  }

  export type Register = (on: On, options?: Record<string, unknown>) => void;
}

// The JSX factory, a global of a hooks module's environment.
declare const h: (
  tag: string | ((props: never) => import("claude-code").RenderNode),
  props: Record<string, unknown> | null | undefined,
  ...children: unknown[]
) => import("claude-code").RenderNode;
