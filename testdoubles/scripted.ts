/**
 * The two pieces every fake shares (TD §25: "스크립트된 응답 큐 + 호출 기록").
 *
 * Deliberately not a fake framework: one error type and one queue, so that the fail-closed rule
 * for an exhausted script is stated once instead of five slightly different ways.
 */

/** Raised by a test double; never by a contract under test. */
export class TestDoubleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDoubleError";
  }
}

export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A FIFO of scripted responses. Running out is an error, never an invented success. */
export class ScriptedResponses<T> {
  readonly #queue: T[] = [];

  push(...values: readonly T[]): void {
    this.#queue.push(...values);
  }

  take(method: string): T {
    if (this.#queue.length === 0) {
      throw new TestDoubleError(`no scripted response left for ${method}()`);
    }
    return this.#queue.shift() as T;
  }

  get remaining(): number {
    return this.#queue.length;
  }
}
