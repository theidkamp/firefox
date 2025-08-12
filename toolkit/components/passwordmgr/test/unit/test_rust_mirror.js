/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 *
 * Tests the AS RustLogins write-only mirror
 */
("use strict");

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { LoginManagerRustStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/storage-rust.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

/**
 * Enable Rust mirror and setup Glean
 */
add_setup(() => {
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);
  // Required for FOG/Glean to work correctly in tests
  do_get_profile();
  Services.fog.initializeFOG();
});

/**
 * Tests addLogin gets synced to Rust Storage
 */
add_task(async function test_mirror_addLogin() {
  const loginInfo = TestData.formLogin({
    username: "username",
    password: "password",
  });
  await Services.logins.addLoginAsync(loginInfo);

  // note LoginManagerRustStorage is a singleton and already initialized when
  // Services.logins gets initialized.
  const rustStorage = new LoginManagerRustStorage();

  const storedLoginInfos = await Services.logins.getAllLogins();
  const rustStoredLoginInfos = await rustStorage.getAllLogins();
  LoginTestUtils.assertLoginListsEqual(storedLoginInfos, rustStoredLoginInfos);

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Tests modifyLogin gets synced to Rust Storage
 */
add_task(async function test_mirror_modifyLogin() {
  const loginInfo = TestData.formLogin({
    username: "username",
    password: "password",
  });
  await Services.logins.addLoginAsync(loginInfo);

  const rustStorage = new LoginManagerRustStorage();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  const modifiedLoginInfo = TestData.formLogin({
    username: "username",
    password: "password",
    usernameField: "new_form_field_username",
    passwordField: "new_form_field_password",
  });
  Services.logins.modifyLogin(storedLoginInfo, modifiedLoginInfo);

  const [storedModifiedLoginInfo] = await Services.logins.getAllLogins();
  const [rustStoredModifiedLoginInfo] = await rustStorage.searchLoginsAsync({
    guid: storedLoginInfo.guid,
  });

  LoginTestUtils.assertLoginListsEqual(
    [storedModifiedLoginInfo],
    [rustStoredModifiedLoginInfo]
  );

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Tests removeLogin gets synced to Rust Storage
 */
add_task(async function test_mirror_removeLogin() {
  const loginInfo = TestData.formLogin({
    username: "username",
    password: "password",
  });
  await Services.logins.addLoginAsync(loginInfo);

  const rustStorage = new LoginManagerRustStorage();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  Services.logins.removeLogin(storedLoginInfo);

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 0);

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Verifies that the migration is triggered by according pref change
 */
add_task(async function test_migration_is_triggered_by_pref_change() {
  // trigger change
  Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", true);

  await TestUtils.waitForCondition(() => {
    return !Services.prefs.getBoolPref(
      "signon.rustMirror.migrationNeeded",
      false
    );
  }, "'signon.rustMirror.migrationNeeded' pref has been reset by migration");
});

/**
 * Verifies that the migration is idempotent by ensuring that running
 * it multiple times does not create duplicate logins in the Rust store.
 */
add_task(async function test_migration_is_idempotent() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();

  let rustLogins = await rustStorage.getAllLogins();
  Assert.equal(
    rustLogins.length,
    1,
    "Rust store contains login after first migration"
  );

  // trigger again
  Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", true);

  await TestUtils.waitForCondition(() => {
    return !Services.prefs.getBoolPref(
      "signon.rustMirror.migrationNeeded",
      false
    );
  }, "'signon.rustMirror.migrationNeeded' pref has been reset by migration");

  rustLogins = await rustStorage.getAllLogins();
  Assert.equal(rustLogins.length, 1, "No duplicate after second migration");

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Verify that the migration:
 *  - continues when some rows fail (partial failure),
 *  - still migrates valid logins,
 */

add_task(async function test_migration_partial_failure() {
  // turn mirror off
  Services.prefs.setBoolPref("signon.rustMirror.enabled", false);

  const rustStorage = new LoginManagerRustStorage();
  // Save the first (valid) login into Rust for real, then simulate results
  sinon.stub(rustStorage, "addLoginsAsync").callsFake(async (logins, _cont) => {
    await rustStorage.addWithMeta(logins[0]);
    return [
      { login: {}, error: null }, // row 0 success
      { login: null, error: { message: "row failed" } }, // row 1 failure
    ];
  });

  const login_ok = TestData.formLogin({
    username: "test-user-ok",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login_ok);
  const login_bad = TestData.formLogin({
    username: "test-user-bad",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login_bad);

  // turn mirror back on
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);
  // trigger re-migration
  Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", true);

  // and wait a little, due to the lack of a migration-complete event.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 200));

  const rustLogins = await rustStorage.getAllLogins();
  Assert.equal(rustLogins.length, 1, "only valid login migrated");

  sinon.restore();
  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Verify that when the bulk add operation rejects (hard failure),
 * the migration itself rejects.
 */
add_task(async function test_migration_rejects_when_bulk_add_rejects() {
  // turn mirror off
  Services.prefs.setBoolPref("signon.rustMirror.enabled", false);

  const rustStorage = new LoginManagerRustStorage();
  // force the bulk add to fail
  sinon.stub(rustStorage, "addLoginsAsync").rejects(new Error("bulk failed"));

  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  // turn mirror back on
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);
  // trigger re-migration
  Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", true);

  // and wait a little, due to the lack of a migration-complete event.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 200));

  const rustLogins = await rustStorage.getAllLogins();
  Assert.equal(rustLogins.length, 0, "zero logins migrated");

  const newPrefValue = Services.prefs.getBoolPref(
    "signon.rustMirror.migrationNeeded",
    false
  );

  Assert.equal(newPrefValue, true, "pref has not been reset");

  sinon.restore();
  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Ensures that migrating a large number of logins (100) from the JSON store to
 * the Rust store completes within a reasonable time frame (under 1 second).
 **/
add_task(async function test_migration_time_under_threshold() {
  const numberOfLogins = 100;
  Services.prefs.setBoolPref("signon.rustMirror.enabled", false);

  const logins = Array.from({ length: numberOfLogins }, (_, i) =>
    TestData.formLogin({
      origin: `https://www${i}.example.com`,
      username: `user${i}`,
    })
  );
  await Services.logins.addLogins(logins);
  await LoginTestUtils.reloadData();

  const rustStorage = new LoginManagerRustStorage();

  const start = Date.now();
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);
  await TestUtils.waitForCondition(() => {
    return !Services.prefs.getBoolPref(
      "signon.rustMirror.migrationNeeded",
      false
    );
  }, "wait for pref to update to false");

  const duration = Date.now() - start;
  Assert.less(duration, 2000, "Migration should complete under 2s");
  Assert.equal(rustStorage.countLogins("", "", ""), numberOfLogins);

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/*
 * Tests that the number of saved logins is appropriately reported to
 * the rust storage.
 */
add_task(async function test_logins_diff_count_rust_storage() {
  Services.fog.testResetFOG();

  // Add login to JSON store
  const login = TestData.formLogin({ username: "glean_user" });
  await Services.logins.addLoginAsync(login);

  // wait a little for glean
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));

  Assert.equal(
    Glean.pwmgr.diffSavedPasswordsRust.testGetValue(),
    0,
    "Rust and JSON storage should have the same number of saved passwords"
  );

  LoginTestUtils.clearData();
});

/*
 * Tests that an error is logged when adding an invalid login to the Rust store.
 * The Rust store is stricter than the JSON store and rejects some formats,
 * such as single-dot origins.
 */
add_task(async function test_rust_mirror_addLogin_failure() {
  Services.fog.testResetFOG();
  // This login will be accepted by JSON but rejected by Rust
  const badLogin = TestData.formLogin({ origin: ".", passwordField: "." });

  await Services.logins.addLoginAsync(badLogin);
  const allLoginsJson = await Services.logins.getAllLogins();
  Assert.equal(
    allLoginsJson.length,
    1,
    "single dot origin login saved to JSON"
  );

  // wait a little for glean
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));

  const rustStorage = new LoginManagerRustStorage();

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(
    allLogins.length,
    0,
    "single dot origin login not saved to Rust"
  );

  const [evt] = Glean.pwmgr.rustMigrationFailure.testGetValue();
  Assert.ok(evt, "event has been emitted");
  Assert.equal(evt.extra?.operation, "add", "event has operation");
  Assert.equal(
    evt.extra?.error_message,
    "Invalid login: Login has illegal origin",
    "event has error_message"
  );
  Assert.equal(evt.name, "rust_migration_failure", "event has name");

  LoginTestUtils.clearData();
});

/*
 * Tests that we collect telemetry if non-ASCII origins get punycoded.
 */
add_task(async function test_punycode_origin_metric() {
  Services.fog.testResetFOG();

  const punicodeOrigin = "https://münich.example.com";
  const login = LoginTestUtils.testData.formLogin({
    origin: punicodeOrigin,
    formActionOrigin: "https://example.com",
    username: "user1",
    password: "pass1",
  });

  await Services.logins.addLoginAsync(login);

  // wait a little for glean
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));

  const rustStorage = new LoginManagerRustStorage();

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 1, "punicode origin login saved to Rust");
  const [rustLogin] = allLogins;
  Assert.equal(
    rustLogin.origin,
    "https://xn--mnich-kva.example.com",
    "origin has been punicoded on the Rust side"
  );

  const evt =
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiOrigin.testGetValue();
  Assert.equal(evt, 1, "event has been emitted");

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/*
 * Tests that we collect telemetry if non-ASCII formorigins get punycoded.
 */
add_task(async function test_punycode_formActionOrigin_metric() {
  Services.fog.testResetFOG();

  const punicodeOrigin = "https://münich.example.com";
  const login = LoginTestUtils.testData.formLogin({
    formActionOrigin: punicodeOrigin,
    origin: "https://example.com",
    username: "user1",
    password: "pass1",
  });

  await Services.logins.addLoginAsync(login);

  // wait a little for glean
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));

  const rustStorage = new LoginManagerRustStorage();

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 1, "punicode origin login saved to Rust");
  const [rustLogin] = allLogins;
  Assert.equal(
    rustLogin.formActionOrigin,
    "https://xn--mnich-kva.example.com",
    "origin has been punicoded on the Rust side"
  );

  const evt =
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiFormAction.testGetValue();
  Assert.equal(evt, 1, "event has been emitted");

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/*
 * Tests that we collect telemetry for single dot in origin
 */
add_task(async function test_single_dot_in_origin() {
  Services.fog.testResetFOG();

  const badOrigin = ".";
  const login = LoginTestUtils.testData.formLogin({
    origin: badOrigin,
    formActionOrigin: "https://example.com",
    username: "user1",
    password: "pass1",
  });

  await Services.logins.addLoginAsync(login);

  // wait a little for glean
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));

  const evt = Glean.pwmgr.rustIncompatibleLoginFormat.dotOrigin.testGetValue();
  Assert.equal(evt, 1, "event has been emitted");

  LoginTestUtils.clearData();
});

/**
 * Tests that a rust_migration_performance event is recorded after migration,
 * containing both duration and total number of migrated logins.
 */
add_task(async function test_migration_performance_probe() {
  Services.fog.testResetFOG();

  const login = TestData.formLogin({
    username: "perf-user",
    password: "perf-password",
  });
  await Services.logins.addLoginAsync(login);

  // trigger migration
  Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", true);

  await TestUtils.waitForCondition(() => {
    return !Services.prefs.getBoolPref(
      "signon.rustMirror.migrationNeeded",
      false
    );
  }, "'signon.rustMirror.migrationNeeded' pref has been reset by migration");

  const [evt] = Glean.pwmgr.rustMigrationPerformance.testGetValue();
  Assert.ok(evt, "rustMigrationPerformance event should have been emitted");
  Assert.equal(
    evt.extra?.total_logins,
    "1",
    "event should record total migrated logins"
  );
  Assert.greaterOrEqual(
    parseInt(evt.extra?.duration_ms, 10),
    0,
    "event should record non-negative duration in ms"
  );

  sinon.restore();
  LoginTestUtils.clearData();
});
