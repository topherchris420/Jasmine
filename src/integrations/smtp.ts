import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { EngineError } from '../errors.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  /** `true` for implicit TLS (465); otherwise STARTTLS is used when offered. */
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
  /** Accept self-signed certificates (local relays such as Mailpit). */
  allowInsecureTls?: boolean;
}

export interface MailMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: boolean;
  replyTo?: string;
}

/** Minimal SMTP client: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA. */
export async function sendMail(config: SmtpConfig, message: MailMessage, signal: AbortSignal): Promise<{ messageId: string; accepted: string[] }> {
  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map((r) => r.trim()).filter(Boolean);
  if (!recipients.length) throw new EngineError('BAD_PAYLOAD', 'Email needs at least one recipient');
  // Display names are allowed ("Ada <ada@example.com>"); line breaks never are (header injection).
  for (const r of [...recipients, config.from]) if (/[\r\n]/.test(r) || !/^[^@\s<>]+@[^@\s<>]+$/.test(extractAddress(r))) throw new EngineError('BAD_PAYLOAD', `Invalid email address: ${r.slice(0, 80)}`);
  if (/[\r\n]/.test(message.subject)) throw new EngineError('BAD_PAYLOAD', 'Subject must be a single line');
  const session = new SmtpSession(config, signal);
  try {
    await session.connect();
    await session.expect(220);
    let ehlo = await session.command(`EHLO jasmine.local`, 250);
    if (!config.secure && /STARTTLS/i.test(ehlo)) {
      await session.command('STARTTLS', 220);
      await session.upgrade();
      ehlo = await session.command('EHLO jasmine.local', 250);
    }
    if (config.username) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo)) {
        await session.command(`AUTH PLAIN ${Buffer.from(`\0${config.username}\0${config.password ?? ''}`).toString('base64')}`, 235, true);
      } else {
        await session.command('AUTH LOGIN', 334);
        await session.command(Buffer.from(config.username).toString('base64'), 334, true);
        await session.command(Buffer.from(config.password ?? '').toString('base64'), 235, true);
      }
    }
    await session.command(`MAIL FROM:<${extractAddress(config.from)}>`, 250);
    const accepted: string[] = [];
    for (const r of recipients) {
      await session.command(`RCPT TO:<${extractAddress(r)}>`, [250, 251]);
      accepted.push(r);
    }
    await session.command('DATA', 354);
    const messageId = `<${randomUUID()}@jasmine.local>`;
    const headers = [
      `From: ${config.from}`, `To: ${message.to.join(', ')}`, ...(message.cc?.length ? [`Cc: ${message.cc.join(', ')}`] : []),
      ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
      `Subject: ${encodeHeader(message.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0',
      `Content-Type: ${message.html ? 'text/html' : 'text/plain'}; charset=utf-8`, 'Content-Transfer-Encoding: base64',
    ];
    const body = Buffer.from(message.body, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
    await session.command(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, 250);
    await session.command('QUIT', 221).catch(() => {});
    return { messageId, accepted };
  } finally {
    session.close();
  }
}

function extractAddress(value: string): string {
  return /<([^>]+)>/.exec(value)?.[1] ?? value.trim();
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

class SmtpSession {
  private socket: net.Socket | tls.TLSSocket | undefined;
  private buffer = '';
  private waiter: (() => void) | undefined;
  private failure: Error | undefined;
  private readonly config: SmtpConfig;
  private readonly signal: AbortSignal;

  constructor(config: SmtpConfig, signal: AbortSignal) {
    this.config = config;
    this.signal = signal;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts = { host: this.config.host, port: this.config.port, servername: this.config.host, rejectUnauthorized: !this.config.allowInsecureTls };
      const socket = this.config.secure ? tls.connect(opts, () => resolve()) : net.connect(opts, () => resolve());
      this.attach(socket);
      socket.once('error', (e) => reject(new EngineError('NETWORK', `SMTP connection to ${this.config.host}:${this.config.port} failed: ${e.message}`, { retryable: true })));
      socket.setTimeout(30_000, () => socket.destroy(new Error('SMTP timeout')));
      this.signal.addEventListener('abort', () => socket.destroy(new Error('cancelled')), { once: true });
    });
  }

  upgrade(): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket!;
      plain.removeAllListeners('data');
      const secure = tls.connect({ socket: plain, servername: this.config.host, rejectUnauthorized: !this.config.allowInsecureTls }, () => resolve());
      secure.once('error', (e) => reject(new EngineError('NETWORK', `SMTP TLS upgrade failed: ${e.message}`)));
      this.attach(secure);
    });
  }

  private attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.waiter?.();
    });
    socket.on('error', (e) => {
      this.failure = e;
      this.waiter?.();
    });
    socket.on('close', () => {
      this.failure ??= new Error('SMTP connection closed');
      this.waiter?.();
    });
  }

  /** Reads one complete (possibly multi-line) reply. */
  private async reply(): Promise<{ code: number; text: string }> {
    for (;;) {
      const lines = this.buffer.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]!)) {
          const text = lines.slice(0, i + 1).join('\n');
          this.buffer = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i]!.slice(0, 3)), text };
        }
      }
      if (this.failure) throw new EngineError('NETWORK', `SMTP: ${this.failure.message}`, { retryable: true });
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }

  async expect(code: number | number[]): Promise<string> {
    const r = await this.reply();
    const ok = Array.isArray(code) ? code.includes(r.code) : r.code === code;
    if (!ok) throw new EngineError(r.code >= 500 ? 'UPSTREAM_HTTP' : 'NETWORK', `SMTP server replied ${r.text.slice(0, 200)}`, { retryable: r.code >= 400 && r.code < 500 });
    return r.text;
  }

  async command(line: string, code: number | number[], secret = false): Promise<string> {
    this.socket!.write(`${line}\r\n`);
    try {
      return await this.expect(code);
    } catch (e) {
      if (secret && e instanceof EngineError) throw new EngineError(e.code, 'SMTP authentication failed; check the username and password', { retryable: false });
      throw e;
    }
  }

  close() {
    this.socket?.destroy();
  }
}
