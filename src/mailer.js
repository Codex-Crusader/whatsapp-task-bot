// Sends the saved report HTML by Gmail SMTP (App Password) to my own address.
import { lookup } from 'node:dns/promises';

const HOST = 'smtp.gmail.com';

export function createMailer({ env, status, log, transportFactory = null }) {
  // Checked at send time: the setup wizard can add the password later.
  const isConfigured = () => !!(env.gmailUser && env.gmailAppPassword && (env.reportTo || env.gmailUser));

  async function transport() {
    if (transportFactory) return transportFactory();
    const nodemailer = (await import('nodemailer')).default; // loaded only once a day
    // Resolve with the OS resolver: nodemailer's own DNS query fails on this laptop.
    // TLS still checks the certificate for smtp.gmail.com.
    const { address } = await lookup(HOST, { family: 4 });
    return nodemailer.createTransport({
      host: address,
      port: 465,
      secure: true,
      tls: { servername: HOST },
      auth: { user: env.gmailUser, pass: env.gmailAppPassword },
    });
  }

  async function sendReport(day, html, stats, { prefix = '' } = {}) {
    if (!isConfigured()) throw new Error('mailer not configured');
    const t = await transport();
    try {
      await t.sendMail({
        from: `WhatsApp Task Bot <${env.gmailUser}>`,
        to: env.reportTo || env.gmailUser,
        subject: `${prefix}WhatsApp report ${day}: ${stats.mine} tasks for you, ${stats.tasks} in total`,
        html,
      });
      status.email.lastAt = Date.now();
      status.email.ok = true;
      log.info('mailer: report sent', { day });
    } catch (err) {
      status.email.ok = false;
      log.error('mailer: send failed', { day, err: err.message });
      throw err;
    } finally {
      t.close?.();
    }
  }

  // Short plain-text alert to my own address (for example: WhatsApp logged out).
  async function sendAlert(subject, text) {
    if (!isConfigured()) throw new Error('mailer not configured');
    const t = await transport();
    try {
      await t.sendMail({ from: `WhatsApp Task Bot <${env.gmailUser}>`, to: env.reportTo || env.gmailUser, subject: `[Alert] ${subject}`, text });
      log.info('mailer: alert sent');
    } finally {
      t.close?.();
    }
  }

  // Setup wizard: one short email to check the App Password.
  async function sendTest() {
    if (!isConfigured()) throw new Error('Gmail address or App Password is missing.');
    const t = await transport();
    try {
      await t.sendMail({ from: `WhatsApp Task Bot <${env.gmailUser}>`, to: env.reportTo || env.gmailUser, subject: '[Test] WhatsApp Task Bot email works', text: 'This test email comes from the setup page of your WhatsApp Task Bot. The daily report will come from the same address.' });
      status.email.ok = true;
    } finally {
      t.close?.();
    }
  }

  return { sendReport, sendAlert, sendTest, get configured() { return isConfigured(); } };
}
