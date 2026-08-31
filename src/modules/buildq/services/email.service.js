import { Resend } from 'resend';
import { env, features } from '../../../config/env.js';
import { buildqEnv } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transactional email for BuildQ.
//
// Same Resend account and same EMAIL_FROM sender as BRG Prime — no new vendor,
// no new domain to verify. Only the template is different, because BuildQ is a
// different product and a construction firm should not receive a BRG Prime
// house-branded email. Point this at the BRG layout instead if you would rather
// they share one identity.
// ─────────────────────────────────────────────────────────────────────────────

const resend = features.email ? new Resend(env.resendApiKey) : null;

const contactAddress = env.emailFrom.match(/<([^>]+)>/)?.[1] ?? env.emailFrom;

function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#F4F7FF;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B2540;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(27,37,64,0.08);">
          <tr><td style="background:linear-gradient(135deg,#1CA5F6 0%,#0D8FD9 100%);padding:24px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:800;">BuildQ AI</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:800;">${title}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:20px 32px;border-top:1px solid #EEF2FA;color:#9AA3BB;font-size:12px;">
            BuildQ AI — AI quantity surveying and cost management.<br/>${contactAddress}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

const button = (href, label) =>
  `<div style="margin:24px 0;">
     <a href="${href}" style="display:inline-block;background:#1CA5F6;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;">${label}</a>
   </div>
   <p style="margin:0;color:#6B7699;font-size:12px;word-break:break-all;">Or paste this into your browser:<br/>${href}</p>`;

// Never throws: a delivery failure must not break signup or reset.
async function send({ to, subject, html }) {
  if (!resend) {
    console.log(`\n[buildq] DEV EMAIL — no RESEND_API_KEY set\n   to: ${to}\n   subject: ${subject}\n`);
    return { delivered: false, dev: true };
  }
  try {
    const { error } = await resend.emails.send({ from: env.emailFrom, to, subject, html });
    if (error) {
      console.error('[buildq] Resend error:', error);
      return { delivered: false, error };
    }
    return { delivered: true };
  } catch (err) {
    console.error('[buildq] Resend threw:', err?.message || err);
    return { delivered: false, error: err };
  }
}

export function sendWelcomeEmail(to, name, trialEndsAt) {
  const ends = new Date(trialEndsAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  return send({
    to,
    subject: 'Welcome to BuildQ AI — your 14-day trial has started',
    html: layout(
      `Welcome, ${name}`,
      `<p style="margin:0 0 12px;line-height:1.6;">Your workspace is ready. You have full access until <strong>${ends}</strong> — no card required.</p>
       <p style="margin:0;line-height:1.6;">Start by creating a project and uploading a drawing.</p>
       ${button(`${buildqEnv.webUrl}/app/dashboard`, 'Open your workspace')}`
    ),
  });
}

export function sendPasswordResetEmail(to, name, token) {
  const href = `${buildqEnv.webUrl}/auth/reset?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Reset your BuildQ AI password',
    html: layout(
      'Reset your password',
      `<p style="margin:0 0 12px;line-height:1.6;">Hi ${name}, we received a request to reset your password. This link can be used once and expires in 60 minutes.</p>
       ${button(href, 'Choose a new password')}
       <p style="margin:16px 0 0;color:#6B7699;font-size:13px;">If you did not ask for this, you can ignore this email — your password will not change.</p>`
    ),
  });
}

export function sendTeamInviteEmail(to, { inviterName, orgName, role, token }) {
  const href = `${buildqEnv.webUrl}/auth/accept-invite?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: `${inviterName} invited you to ${orgName} on BuildQ AI`,
    html: layout(
      `Join ${orgName}`,
      `<p style="margin:0 0 12px;line-height:1.6;">${inviterName} has invited you to join <strong>${orgName}</strong> on BuildQ AI as <strong>${role}</strong>.</p>
       <p style="margin:0 0 12px;line-height:1.6;">Follow the link and you will either create an account on this email address, or sign in with the one you already have — either way you land in ${orgName}.</p>
       ${button(href, 'Accept the invitation')}
       <p style="margin:16px 0 0;color:#6B7699;font-size:13px;">This invitation expires in 7 days and can be used once.</p>`
    ),
  });
}

export function sendAnalysisCompleteEmail(to, name, { documentName, projectName }) {
  return send({
    to,
    subject: `Analysis finished — ${documentName}`,
    html: layout(
      'Your drawing has been analysed',
      `<p style="margin:0 0 12px;line-height:1.6;">Hi ${name}, BuildQ has finished reading <strong>${documentName}</strong> on ${projectName}.</p>
       ${button(`${buildqEnv.webUrl}/app/takeoff`, 'Review the measurements')}`
    ),
  });
}
