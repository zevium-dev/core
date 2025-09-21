import { Exception } from "@boi.gg/exception";
import { type CreateEmailOptions, type CreateEmailRequestOptions, Resend } from "resend";

import { serverEnv } from "~/env/server";

export class EmailException extends Exception.kind<{ errorMsg: string; to: Array<string> | string }>(
  "EmailException",
) {}

export const resend = new Resend(serverEnv.RESEND_API_KEY);

export const sendEmail = async (payload: CreateEmailOptions, options?: CreateEmailRequestOptions) => {
  const res = await resend.emails.send(payload, options);
  if (res.error) {
    throw new EmailException("[RESEND]: Failed to send email", { errorMsg: res.error.message, to: payload.to });
  }
  return res.data.id;
};
