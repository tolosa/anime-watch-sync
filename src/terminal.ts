import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

export const clean = (value: string) => stripVTControlCharacters(value).replace(/[\r\n\t]/g, " ");

export interface MappingPrompt {
  read(question: string): Promise<string | null>;
  write(message: string): void;
}

export class TerminalPrompt implements MappingPrompt, Disposable {
  private readonly reader: Interface;
  private readonly closed = new AbortController();
  private readonly output: Writable;

  constructor(input: Readable = process.stdin, output: Writable = process.stdout) {
    this.output = output;
    this.reader = createInterface({ input, output });
    // readline closing (including Ctrl+C / Ctrl+D) must settle a pending question.
    this.reader.once("close", () => this.closed.abort());
  }

  async read(question: string): Promise<string | null> {
    if (this.closed.signal.aborted) return null;
    try {
      return (await this.reader.question(clean(question), { signal: this.closed.signal })).trim();
    } catch (error) {
      if (this.closed.signal.aborted) return null;
      throw error;
    }
  }

  write(message: string): void {
    this.output.write(`${clean(message)}\n`);
  }

  [Symbol.dispose](): void {
    this.reader.close();
  }
}
