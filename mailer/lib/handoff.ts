import { SignJWT, jwtVerify } from "jose";

export type MailerHandoffPayload = {
  user_id: number;
  username: string;
  mailbox_email: string;
  display_name?: string | null;
  buyer_ids: number[];
  /** Optional lead snapshot so mailer can render without calling Railway mid-send */
  leads?: Array<{
    buyer_id: number;
    company_name: string;
    contact_name?: string | null;
    contact_email: string;
  }>;
};

function secretKey(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function signHandoff(
  payload: MailerHandoffPayload,
  secret: string,
  expiresIn = "20m",
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey(secret));
}

export async function verifyHandoff(
  token: string,
  secret: string,
): Promise<MailerHandoffPayload> {
  const { payload } = await jwtVerify(token, secretKey(secret));
  const user_id = Number(payload.user_id);
  const username = String(payload.username || "");
  const mailbox_email = String(payload.mailbox_email || "");
  const buyer_ids = Array.isArray(payload.buyer_ids)
    ? payload.buyer_ids.map((id) => Number(id)).filter((n) => Number.isFinite(n))
    : [];
  if (!user_id || !username || !mailbox_email) {
    throw new Error("Invalid handoff token");
  }
  return {
    user_id,
    username,
    mailbox_email,
    display_name: (payload.display_name as string) || null,
    buyer_ids,
    leads: Array.isArray(payload.leads)
      ? (payload.leads as MailerHandoffPayload["leads"])
      : [],
  };
}
