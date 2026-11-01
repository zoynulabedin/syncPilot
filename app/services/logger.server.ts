import pino from "pino";

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
