/** Escapes user-provided text (names, mess names) before it goes into email HTML. */
export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const layout = (title: string, body: string) => `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 16px">${title}</h2>
  ${body}
  <p style="margin-top:32px;font-size:12px;color:#666">Messora — mess management made simple</p>
</div>`;

const codeBox = (code: string) =>
  `<p style="font-size:28px;letter-spacing:8px;font-weight:bold;background:#f4f4f5;padding:12px 16px;border-radius:8px;display:inline-block">${code}</p>`;

export const verifyEmailTemplate = (name: string, code: string, minutes: number) =>
  layout(
    "Verify your email",
    `<p>Hi ${escapeHtml(name)},</p><p>Use this code to verify your email address on Messora:</p>${codeBox(code)}<p>The code expires in ${minutes} minutes.</p>`,
  );

export const resetPasswordTemplate = (name: string, code: string, minutes: number) =>
  layout(
    "Reset your password",
    `<p>Hi ${escapeHtml(name)},</p><p>Use this code to reset your Messora password:</p>${codeBox(code)}<p>The code expires in ${minutes} minutes. If you didn't request this, you can ignore this email.</p>`,
  );

const button = (href: string, label: string) =>
  `<p><a href="${href}" style="display:inline-block;padding:12px 20px;background:#059669;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${label}</a></p>
   <p style="font-size:12px;color:#666">Or open this link: ${href}</p>`;

export const invitationTemplate = (inviterName: string, messName: string, link: string, days: number) =>
  layout(
    `Join ${escapeHtml(messName)} on Messora`,
    `<p><strong>${escapeHtml(inviterName)}</strong> invited you to join <strong>${escapeHtml(messName)}</strong>, where meals, bazar and the monthly bill are managed on Messora.</p>${button(link, "Accept invitation")}<p>This invitation expires in ${days} days.</p>`,
  );
