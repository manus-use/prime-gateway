import type {
  AgentRuntime,
  Driver,
  DriverEvent,
  PermissionOutcome,
  PromptInput,
  StartMode,
  StartOptions,
  StartResult,
} from '../../src/driver/types.js';
import type { PermissionOption, TurnTerminal } from '../../src/types.js';

/**
 * A scripted `Driver`.
 *
 * The point of scripting turns rather than stubbing methods is that the
 * interesting behaviour in `SessionActor` is all about *streams that end
 * strangely*: a stream with no terminal, a stream that dies after the prompt was
 * accepted, a stream parked forever on a permission nobody answers. A stub
 * returning a fixed array cannot express any of them.
 */

export interface TurnControl {
  emit(event: DriverEvent): void;
  /**
   * Emit a permission request and wait for the answer.
   *
   * Resolves when the core settles it -- from a card click, a cancel, or
   * teardown. A test that never settles hangs the turn, which is exactly the
   * failure the core's release paths exist to prevent, so it is worth being
   * able to reproduce.
   */
  ask(action: string, options: readonly PermissionOption[]): Promise<PermissionOutcome>;
  end(terminal: TurnTerminal): void;
}

export type TurnScript = (ctl: TurnControl) => Promise<void> | void;

/** Minimal push-to-pull bridge, mirroring the one in the real ACP driver. */
class Queue {
  #buffer: DriverEvent[] = [];
  #waiting: ((r: IteratorResult<DriverEvent>) => void) | undefined;
  #done = false;

  push(event: DriverEvent): void {
    if (this.#done) return;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: event, done: false });
      return;
    }
    this.#buffer.push(event);
  }

  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    if (waiting !== undefined && this.#buffer.length === 0) {
      this.#waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<DriverEvent>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}

export class FakeRuntime implements AgentRuntime {
  readonly prompts: PromptInput[] = [];
  cancels = 0;
  closes = 0;
  /** Set to make the next `prompt()` throw before emitting anything. */
  failPromptWith: unknown = undefined;

  readonly #driver: FakeDriver;

  constructor(driver: FakeDriver) {
    this.#driver = driver;
  }

  get providerSessionId(): string {
    return this.#driver.providerSessionId;
  }

  prompt(input: PromptInput): AsyncIterable<DriverEvent> {
    this.prompts.push(input);

    const failure = this.failPromptWith;
    if (failure !== undefined) {
      this.failPromptWith = undefined;
      // Thrown from `prompt` itself, so the core sees a turn it delivered and got
      // nothing back from -- the `ambiguous` case, not the `failed` one.
      throw failure instanceof Error ? failure : new Error(String(failure));
    }

    const script = this.#driver.scripts.shift() ?? ((ctl: TurnControl) => ctl.end('completed'));
    const queue = new Queue();

    void (async () => {
      const ctl: TurnControl = {
        emit: (event) => queue.push(event),
        ask: (action, options) =>
          new Promise<PermissionOutcome>((resolve) => {
            queue.push({
              kind: 'permission-request',
              requestId: `req_${action}`,
              action,
              options: [...options],
              raw: { action },
              resolve,
            });
          }),
        end: (terminal) => queue.push({ kind: 'turn-ended', terminal }),
      };
      try {
        await script(ctl);
      } catch (err) {
        queue.push({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
      } finally {
        queue.end();
      }
    })();

    return { [Symbol.asyncIterator]: () => ({ next: () => queue.next() }) };
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

export class FakeDriver implements Driver {
  readonly id: string;
  readonly starts: StartOptions[] = [];
  readonly runtimes: FakeRuntime[] = [];
  /** Consumed one per turn. An exhausted list means "complete immediately". */
  scripts: TurnScript[] = [];
  providerSessionId = 'prov_fake_1';
  mode: StartMode = 'fresh';
  failStartWith: unknown = undefined;
  /** Runs inside `start`, before the runtime exists. Lets a test move state mid-start. */
  onStart: (() => Promise<void> | void) | undefined = undefined;

  constructor(id = 'fake') {
    this.id = id;
  }

  async start(opts: StartOptions): Promise<{ runtime: AgentRuntime; result: StartResult }> {
    this.starts.push(opts);
    await this.onStart?.();
    if (this.failStartWith !== undefined) {
      const err = this.failStartWith;
      throw err instanceof Error ? err : new Error(String(err));
    }
    const runtime = new FakeRuntime(this);
    this.runtimes.push(runtime);
    return { runtime, result: { providerSessionId: this.providerSessionId, mode: this.mode } };
  }

  get lastRuntime(): FakeRuntime | undefined {
    return this.runtimes.at(-1);
  }
}
