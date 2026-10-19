import { env } from "../config/env.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

interface SendMailInput {
  to: { email: string; name?: string };
  subject: string;
  html: string;
}

/**
 * Sends a transactional email through Brevo.
 * Without BREVO_API_KEY (local development) the email is printed to the console instead.
 */
export async function sendMail({ to, subject, html }: SendMailInput): Promise<void> {
  if (!env.BREVO_API_KEY) {
    console.info(`[mail:dev] To: ${to.email} | Subject: ${subject}\n${html}\n`);
    return;
  }

  const res = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
      to: [to],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    throw new Error(`Brevo send failed (${res.status}): ${await res.text()}`);
  }
}
