// Newline-delimited JSON framing. The caller decodes bytes to text (`socket.setEncoding('utf8')`
// or `TextDecoder` with `stream: true`), so multi-byte characters never split across chunks here.

export function encodeLine(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

export class LineTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`line exceeds ${limit} characters`);
    this.name = 'LineTooLongError';
  }
}

export class LineDecoder {
  // A multi-MB profile arrives in many chunks: keep the pieces and scan only new text for '\n'.
  #parts: string[] = [];
  #partsLength = 0;

  /** CPU profiles of busy processes run to a few MB; the cap guards against a peer that never sends '\n'. */
  constructor(private readonly maxLineLength = 64 * 1024 * 1024) {}

  /** Complete lines in this chunk (without '\n' or a trailing '\r'); blank lines are skipped. */
  push(chunk: string): string[] {
    const lines: string[] = [];
    let from = 0;
    for (let newline = chunk.indexOf('\n'); newline !== -1; newline = chunk.indexOf('\n', from)) {
      let line = this.#takeWith(chunk.slice(from, newline));
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > this.maxLineLength) throw new LineTooLongError(this.maxLineLength);
      if (line.length > 0) lines.push(line);
      from = newline + 1;
    }
    if (from < chunk.length) {
      const rest = chunk.slice(from);
      this.#parts.push(rest);
      this.#partsLength += rest.length;
      if (this.#partsLength > this.maxLineLength) throw new LineTooLongError(this.maxLineLength);
    }
    return lines;
  }

  /** Text received after the last '\n'. */
  get pending(): string {
    return this.#parts.join('');
  }

  #takeWith(tail: string): string {
    if (this.#parts.length === 0) return tail;
    this.#parts.push(tail);
    const line = this.#parts.join('');
    this.#parts = [];
    this.#partsLength = 0;
    return line;
  }
}
