/**
 * SMTP mail transport for better-auth email flows (verification / password
 * reset) — PG-IMPL-SPEC §3.3, §5.1.
 *
 * Load-safety: the nodemailer transport is created lazily on first send, NOT at
 * import time, and only when the SMTP_* env is present. This keeps the module
 * importable (and `next build` green) without any SMTP configuration — a missing
 * config degrades to a logged warning at send time rather than a crash, which is
 * the sensible behaviour for local/full-stack dev without a mail server.
 */
import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | null | undefined;

/** Build (once) the SMTP transport, or `null` when SMTP is not configured. */
function getTransport(): Transporter | null {
  if (transporter !== undefined) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    // 465 → implicit TLS; other ports use STARTTLS when offered.
    secure: Number(port) === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
  return transporter;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Escape a string for safe interpolation into an HTML email body. Tenant-controlled
 * values (e.g. `company.name`) reach outbound HTML sent to external, not-yet-authed
 * recipients; without escaping a tenant could inject markup/links (content-injection
 * / phishing) into a message that legitimately originates from us (T2.3 review, Low #3).
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send a transactional email over SMTP. No-ops with a warning when SMTP is not
 * configured, so auth flows never throw solely because mail is unset in dev.
 */
export async function sendMail({
  to,
  subject,
  text,
  html,
}: MailInput): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    console.warn(
      `[mailer] SMTP not configured (SMTP_HOST/SMTP_PORT missing) — skipping email "${subject}" to ${to}.`,
    );
    return;
  }

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
  await transport.sendMail({ from, to, subject, text, html });
}
