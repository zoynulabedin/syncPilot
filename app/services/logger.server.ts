import pino from "pino";

const SECRET_PATTERNS = [
  /\b(id_token|hmac|signature|session|code|state|access_token|refresh_token)=[^&\s"']*/gi,
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /\bshp[a-z]{2}_[\w]+/gi,
];
/** Redaction works on field names; a token inside a message needs this instead. */
export function scrubSecrets(text: string) {
  return SECRET_PATTERNS.reduce(
    (scrubbed, pattern) => scrubbed.replace(pattern, "[REDACTED]"),
    text,
  );
}
/** The parts of a thrown value that are safe to ship with the logs. */
export function safeError(error: unknown) {
  const known = error instanceof Error ? error : new Error(String(error));
  return {
    name: known.name,
    message: scrubSecrets(known.message),
    stack: known.stack && scrubSecrets(known.stack),
  };
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "accessToken",
      "refreshToken",
      "secret",
      "password",
      "authorization",
      "headers.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "databaseUrl",
      "payload",
      "*.accessToken",
      "*.refreshToken",
    ],
    censor: "[REDACTED]",
  },
});
