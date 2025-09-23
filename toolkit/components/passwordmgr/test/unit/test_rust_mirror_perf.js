/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 *
 * Performance tests for the RustLogins mirror
 */
("use strict");

/* exported perfMetadata */
var perfMetadata = {
  owner: "Credential Management Team",
  name: "RustMirror perf",
  description: "XPCShell perf tests for Rust mirror hot paths and migration.",
  options: {
    default: {
      perfherder: true,
      perfherder_metrics: [
        { name: "mirror_add_ops_per_s", unit: "ops/s", shouldAlert: true },
        { name: "mirror_modify_ops_per_s", unit: "ops/s", shouldAlert: true },
        { name: "mirror_remove_ops_per_s", unit: "ops/s", shouldAlert: true },
        { name: "mirror_migration_100logins_ms", unit: "ms", shouldAlert: true },
      ],
      xpcshell_cycles: 3,
      verbose: true,
    },
  },
  tags: ["passwordmgr", "rustlogins", "mirror"],
};

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { LoginManagerRustStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/storage-rust.sys.mjs"
);

/**
 * Enable Rust mirror
 */
add_setup(() => {
  do_get_profile();
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);
});

function makeLogin(i) {
  return TestData.formLogin({
    origin: `https://www${i}.example.com`,
    username: `user${i}`,
    password: "pass",
  });
}

/**
 * Perf: addLogin throughput
 */
add_task(async function test_perf_addLogin() {
  const rustStorage = new LoginManagerRustStorage();
  const N = 1000;
  const logins = Array.from({ length: N }, (_, i) => makeLogin(i));

  const start = ChromeUtils.now();
  for (const login of logins) {
    await Services.logins.addLoginAsync(login);
  }
  const duration = ChromeUtils.now() - start;
  const opsPerS = (N / duration) * 1000;

  info("perfMetrics", { mirror_add_ops_per_s: opsPerS });
  Assert.ok(opsPerS > 0, "sanity check addLogin throughput");

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Perf: modifyLogin throughput
 */
add_task(async function test_perf_modifyLogin() {
    const rustStorage = new LoginManagerRustStorage();
    const N = 500;
  
    // Prepopulate with N logins
    const logins = Array.from({ length: N }, (_, i) =>
      TestData.formLogin({
        origin: `https://example-${i}.com`,
        username: `user${i}`,
        password: `pass${i}`,
      })
    );
    await Services.logins.addLogins(logins);
  
    const storedLogins = await Services.logins.getAllLogins();
  
    const start = ChromeUtils.now();
    for (let i = 0; i < N; i++) {
      const oldLogin = storedLogins[i];
      const modified = TestData.formLogin({
        origin: oldLogin.origin,
        username: `changed-${i}`,
        password: `changed-pass-${i}`,
      });
      Services.logins.modifyLogin(oldLogin, modified);
    }
    const duration = ChromeUtils.now() - start;
    const opsPerS = (N / duration) * 1000;
  
    info("perfMetrics", { mirror_modify_ops_per_s: opsPerS });
    Assert.ok(opsPerS > 0, "sanity check modifyLogin throughput");
  
    LoginTestUtils.clearData();
    rustStorage.removeAllLogins();
  });

/**
 * Perf: removeLogin throughput
 */
add_task(async function test_perf_removeLogin() {
  const rustStorage = new LoginManagerRustStorage();
  const N = 500;
  const logins = Array.from({ length: N }, (_, i) => makeLogin(i));
  await Services.logins.addLogins(logins);

  const all = await Services.logins.getAllLogins();

  const start = ChromeUtils.now();
  for (const login of all) {
    Services.logins.removeLogin(login);
  }
  const duration = ChromeUtils.now() - start;
  const opsPerS = (N / duration) * 1000;

  info("perfMetrics",{ mirror_remove_ops_per_s: opsPerS });
  Assert.ok(opsPerS > 0, "sanity check removeLogin throughput");

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Perf: migration duration (100 logins)
 */
add_task(async function test_perf_migration_duration() {
  const rustStorage = new LoginManagerRustStorage();
  const N = 100;
  const logins = Array.from({ length: N }, (_, i) => makeLogin(i));
  await Services.logins.addLogins(logins);

  Services.prefs.setBoolPref("signon.rustMirror.enabled", false);
  await LoginTestUtils.reloadData();

  const start = Date.now();
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);

  await TestUtils.waitForCondition(() => {
    return !Services.prefs.getBoolPref("signon.rustMirror.migrationNeeded", false);
  }, "wait for migration pref to reset");

  const duration = Date.now() - start;
  info("perfMetrics", { mirror_migration_100logins_ms: duration });

  Assert.equal(rustStorage.countLogins("", "", ""), N);
  Assert.less(duration, 5000, "Migration should finish in reasonable time");

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});
