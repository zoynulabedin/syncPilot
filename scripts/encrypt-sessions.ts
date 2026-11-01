import prisma from "../app/db.server";
import {
  encryptToken,
  validateTokenEncryption,
} from "../app/services/token-crypto.server";

if (!process.env.SESSION_ENCRYPTION_KEY)
  throw new Error("Configure SESSION_ENCRYPTION_KEY before migrating sessions");
validateTokenEncryption();
let migrated = 0;
try {
  const sessions = await prisma.session.findMany();
  for (const session of sessions) {
    const access = session.accessToken.startsWith("enc:v1:")
      ? session.accessToken
      : encryptToken(
          session.accessToken,
          `${session.shop}:${session.id}:access`,
        )!;
    const refresh = session.refreshToken?.startsWith("enc:v1:")
      ? session.refreshToken
      : encryptToken(
          session.refreshToken ?? undefined,
          `${session.shop}:${session.id}:refresh`,
        );
    if (
      access === session.accessToken &&
      (refresh ?? null) === session.refreshToken
    )
      continue;
    const result = await prisma.session.updateMany({
      where: {
        id: session.id,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      },
      data: { accessToken: access, refreshToken: refresh ?? null },
    });
    migrated += result.count;
  }
  console.log(
    `Encrypted ${migrated} legacy session(s). No credentials were printed.`,
  );
} finally {
  await prisma.$disconnect();
}
