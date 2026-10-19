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
    `<p>Hi ${name},</p><p>Use this code to verify your email address on Messora:</p>${codeBox(code)}<p>The code expires in ${minutes} minutes.</p>`,
  );

export const resetPasswordTemplate = (name: string, code: string, minutes: number) =>
  layout(
    "Reset your password",
    `<p>Hi ${name},</p><p>Use this code to reset your Messora password:</p>${codeBox(code)}<p>The code expires in ${minutes} minutes. If you didn't request this, you can ignore this email.</p>`,
  );
