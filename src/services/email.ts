import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface ResetMailer { sendReset(email: string, token: string): Promise<void> }

export function createResetMailer(config: Config): ResetMailer | undefined {
  if (!config.emailConfigured) return undefined;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465,
    requireTLS: config.NODE_ENV === 'production' && config.SMTP_PORT !== 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000, socketTimeout: 15_000,
  });
  return { async sendReset(email, token) {
    const url = new URL(config.PASSWORD_RESET_URL!);
    url.searchParams.set('token', token);
    await transport.sendMail({
      from: config.SMTP_FROM, to: email, subject: 'Reset your Scout des Apôtres password',
      text: `Use this link to reset your password. It expires in 30 minutes.\n\n${url.toString()}`,
    });
  } };
}
