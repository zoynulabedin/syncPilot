if (process.env.TEST_DATABASE_URL) {
  const target = new URL(process.env.TEST_DATABASE_URL);
  if (
    !/^\/syncpilot_test_[a-f0-9]+$/.test(target.pathname) ||
    process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL ||
    !["localhost", "127.0.0.1", "postgres"].includes(target.hostname)
  ) {
    throw new Error(
      "Integration tests require a disposable local syncpilot_test database; use npm run test:integration",
    );
  }
}
