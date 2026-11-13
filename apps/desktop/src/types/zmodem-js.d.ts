declare module 'zmodem.js' {
  interface Transfer {
    get_offset(): number;
    send(data: Uint8Array): void;
    end(data?: Uint8Array): Promise<void>;
  }
  interface Session {
    type: 'send' | 'receive';
    set_sender(sender: (data: number[]) => void): void;
    on(event: 'garbage', callback: (data: number[]) => void): void;
    on(event: 'session_end', callback: () => void): void;
    consume(data: number[]): void;
    has_ended(): boolean;
    aborted(): boolean;
    abort(): void;
    send_offer(file: { name: string; size: number; mtime: number }): Promise<Transfer | undefined>;
    close(): Promise<void>;
  }
  const Zmodem: { Session: { parse(data: number[]): Session | undefined } };
  export default Zmodem;
}
