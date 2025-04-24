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
 * Enable Rust mirror
 */
add_setup(() => {
  Services.prefs.setBoolPref("signon.rustMirror.enabled", true);
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
