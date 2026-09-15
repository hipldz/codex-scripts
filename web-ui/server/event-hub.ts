export type BufferedEvent = { cursor: number; message: any };

export class EventHub {
  private cursor = 0;
  private events: BufferedEvent[] = [];
  constructor(private readonly limit = 1000) {}
  get current() { return this.cursor; }

  push(message: any) {
    this.events.push({ cursor: ++this.cursor, message });
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  read(after: number) {
    const oldest = this.events[0]?.cursor || this.cursor;
    return { cursor: this.cursor, reset: after > 0 && after < oldest - 1, events: this.events.filter((event) => event.cursor > after) };
  }
}
