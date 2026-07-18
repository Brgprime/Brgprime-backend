import { Resend } from 'resend';
import { env, features } from '../config/env.js';

const resend = features.email ? new Resend(env.resendApiKey) : null;

// Footer contact address, taken from EMAIL_FROM ("Name <addr>" or a bare
// address) so it can never drift from the domain we actually send as.
const contactAddress = env.emailFrom.match(/<([^>]+)>/)?.[1] ?? env.emailFrom;

// Brand-styled wrapper for all transactional emails.
function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#F4F7FF;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2540;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(27,37,64,0.08);">
          <tr><td style="background:linear-gradient(135deg,#1CA5F6 0%,#0D8FD9 100%);padding:24px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:800;">🏠 BRG Prime</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:800;">${title}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:20px 32px;border-top:1px solid #EEF2FA;color:#9AA3BB;font-size:12px;">
            BRG Prime — Buy. Sell. Rent. Lease.<br/>Plot 760, Victoria Island, Lagos · ${contactAddress}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

const codeBlock = (code) =>
  `<div style="margin:20px 0;text-align:center;">
     <span style="display:inline-block;font-size:32px;letter-spacing:10px;font-weight:800;color:#1CA5F6;background:#F4F7FF;border-radius:12px;padding:16px 24px;">${code}</span>
   </div>`;

// Core send helper — uses Resend if configured, otherwise logs to console (dev).
// Never throws: a delivery failure must not break registration / reset flows.
async function send({ to, subject, html }) {
  if (!resend) {
    console.log(`\n📧  [DEV EMAIL — no RESEND_API_KEY set]\n   to: ${to}\n   subject: ${subject}\n`);
    return { delivered: false, dev: true };
  }
  try {
    const { error } = await resend.emails.send({ from: env.emailFrom, to, subject, html });
    if (error) {
      console.error('Resend error:', error);
      return { delivered: false, error };
    }
    return { delivered: true };
  } catch (err) {
    console.error('Resend threw:', err?.message || err);
    return { delivered: false, error: err };
  }
}

export function sendOtpEmail(to, name, code) {
  const html = layout(
    'Verify your email',
    `<p style="color:#5E6A8A;font-size:14px;line-height:1.6;">Hi ${name || 'there'}, welcome to BRG Prime! Use the code below to verify your account. It expires in 10 minutes.</p>
     ${codeBlock(code)}
     <p style="color:#9AA3BB;font-size:12px;">If you didn't create this account, you can ignore this email.</p>`
  );
  return send({ to, subject: 'Your BRG Prime verification code', html });
}

export function sendResetEmail(to, name, code) {
  const link = `${env.webUrl}/reset-password?email=${encodeURIComponent(to)}`;
  const html = layout(
    'Reset your password',
    `<p style="color:#5E6A8A;font-size:14px;line-height:1.6;">Hi ${name || 'there'}, we received a request to reset your BRG Prime password. Use the code below (expires in 10 minutes):</p>
     ${codeBlock(code)}
     <p style="color:#5E6A8A;font-size:14px;">Then continue here: <a href="${link}" style="color:#1CA5F6;">Reset password</a></p>
     <p style="color:#9AA3BB;font-size:12px;">Didn't request this? Your password is safe — just ignore this email.</p>`
  );
  return send({ to, subject: 'Reset your BRG Prime password', html });
}

export function sendWelcomeEmail(to, name) {
  const html = layout(
    `Welcome, ${name || 'to BRG Prime'}! 🎉`,
    `<p style="color:#5E6A8A;font-size:14px;line-height:1.6;">Your account is verified. You can now browse verified listings nationwide, save favourites, and post your own properties.</p>
     <p style="margin-top:20px;"><a href="${env.webUrl}/dashboard" style="display:inline-block;background:#1CA5F6;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">Go to your dashboard</a></p>`
  );
  return send({ to, subject: 'Welcome to BRG Prime', html }).catch(() => {}); // non-critical
}
