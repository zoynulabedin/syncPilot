import { restoreEncryptedDrill } from "./lib/backup-tools";

try {
  if (!process.argv[2]) throw new Error("Encrypted backup path required");
  const result = await restoreEncryptedDrill(process.argv[2]);
  console.log(
    JSON.stringify({
      status: "PASS",
      ...result,
      applicationDatabaseModified: false,
    }),
  );
  if (!result.encryptedSessionsVerified)
    console.log(
      "No restored sessions were present; this run does not establish session-key recovery.",
    );
} catch {
  console.error(
    "Encrypted restore drill failed. Check the backup/session keys, PostgreSQL tools and local disposable-database permissions. No application database was replaced.",
  );
  process.exitCode = 1;
}
