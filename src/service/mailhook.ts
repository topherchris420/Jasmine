import { randomBytes } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { Jasmine } from '../app.ts';
import { EngineError } from '../errors.ts';
import type { AddressInfo } from 'node:net';

/** Local SMTP ingress. Each deployed mail flow has a durable random recipient address. */
export class MailhookService {
  constructor(app: Jasmine) {
    this.app = app;
  }
  private readonly app: Jasmine;
  private server: SMTPServer | undefined;
  addresses() {
    const domain = this.app.config.env?.['MAIL_DOMAIN'] ?? 'localhost';
    return this.app.deployments
      .activeFlows()
      .filter((d) => d.plan.nodes.get(d.plan.triggerId)?.node.type === 'mailhookNode')
      .map((d) => {
        const key = `mailhook:${d.flowId}`;
        let token = this.app.settings.get<string | null>(key, null);
        if (!token) {
          token = randomBytes(12).toString('hex');
          this.app.settings.set(key, token);
        }
        return { flowId: d.flowId, address: `${token}@${domain}` };
      });
  }
  async start(port = 2525, host = '127.0.0.1'): Promise<number> {
    if (this.server) throw new EngineError('CONFLICT', 'SMTP ingress is already running');
    this.server = new SMTPServer({
      name: 'Jasmine',
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      size: 25 * 1024 * 1024,
      onRcptTo: (address, _session, callback) => {
        if (this.addresses().some((a) => a.address.toLowerCase() === address.address.toLowerCase())) callback();
        else callback(Object.assign(new Error('Unknown workflow recipient'), { responseCode: 550 }));
      },
      onData: (stream, session, callback) => {
        void (async () => {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += (chunk as Buffer).length;
            if (size > 25 * 1024 * 1024) throw new Error('Email exceeds 25 MB');
            chunks.push(chunk as Buffer);
          }
          const mail = await simpleParser(Buffer.concat(chunks));
          const attachments = mail.attachments.map((a) => {
            const f = this.app.files.save(a.content, a.filename ?? 'attachment', a.contentType);
            return { filename: f.name, contentType: f.mime, size: f.size, key: f.id, url: this.app.fileUrl(f.id) };
          });
          for (const recipient of session.envelope.rcptTo) {
            const route = this.addresses().find((a) => a.address.toLowerCase() === recipient.address.toLowerCase());
            if (!route) continue;
            await this.app.runs.executeWorkflow(
              route.flowId,
              {
                webhookId: route.flowId,
                to: recipient.address,
                from: mail.from?.text ?? '',
                subject: mail.subject ?? '',
                text: mail.text ?? '',
                html: typeof mail.html === 'string' ? mail.html : '',
                attachments,
              },
              { mode: 'async', source: 'mail' },
            );
          }
        })().then(
          () => callback(),
          (e) => callback(e as Error),
        );
      },
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return (server.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
