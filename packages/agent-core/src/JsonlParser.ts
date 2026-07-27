export type JsonlValueHandler = (value: unknown) => void;
export type JsonlErrorHandler = (error: Error, line: string) => void;

export class JsonlParser {
  private buffer = "";

  constructor(
    private readonly onValue: JsonlValueHandler,
    private readonly onError: JsonlErrorHandler,
  ) {}

  push(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.parseLine(line);
  }

  finish(): void {
    if (this.buffer.trim() !== "") this.parseLine(this.buffer);
    this.buffer = "";
  }

  private parseLine(line: string): void {
    if (line.trim() === "") return;
    try {
      this.onValue(JSON.parse(line) as unknown);
    } catch (cause) {
      this.onError(new Error("Malformed JSONL message", { cause }), line);
    }
  }
}
