/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 *
 * Tests the AS RustLogins write-only mirror
 */

const { LoginManagerRustStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/storage-rust.sys.mjs"
);
const { LoginManagerRustMirror } = ChromeUtils.importESModule(
  "resource://gre/modules/LoginManagerRustMirror.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

("use strict");

/**
 * Enable Rust mirror
 */
add_setup(async () => {
  Services.prefs.setBoolPref("signon.loginsRustMirror.enabled", true);
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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

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
  await LoginTestUtils.reloadData();
  await LoginTestUtils.checkLogins([loginInfo]);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

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

  await LoginTestUtils.clearData();
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
  await rustStorage.initialize();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  Services.logins.removeLogin(storedLoginInfo);

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 0);

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Verifies that the rolling migration is idempotent by ensuring that running
 * it multiple times does not create duplicate logins in the Rust store.
 */
add_task(async function test_migration_is_idempotent() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  // run mirror
  await mirror.enable();
  // run mirror manually, again
  await mirror.maybeRunRollingMigrationToRustStorage();
  // run mirror again
  await mirror.maybeRunRollingMigrationToRustStorage();

  let rustLogins = await rustStorage.getAllLogins();
  Assert.equal(rustLogins.length, 1, "No duplicate after second migration");

  mirror.disable();
  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Verifies that the Rust store is reset and re-migrated when the JSON store checksum changes,
 * ensuring outdated or mismatched logins are dropped.
 */
add_task(async function test_rolling_migration_drops_rust_on_checksum_change() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  await mirror.maybeRunRollingMigrationToRustStorage();

  // Step 2: Mutate JSON store to change checksum
  await Services.logins.removeAllLogins();
  const newLogin = TestData.formLogin({
    username: "test-user-2",
    password: "secure-password-2",
  });
  await Services.logins.addLoginAsync(newLogin);

  // Step 3: Run second migration (checksum mismatch expected)
  await mirror.maybeRunRollingMigrationToRustStorage();

  let rustLoginsAfter = await rustStorage.getAllLogins();
  LoginTestUtils.assertLoginListsEqual(
    rustLoginsAfter,
    [newLogin],
    "Rust store should only contain new login after second migration"
  );

  mirror.disable();
  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/**
 * Verifies that the rolling migration avoids redundant updates by not
 * attempting to re-add logins that haven't changed since the last migration.
 */
add_task(async function test_avoid_redundant_updates() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  await mirror.maybeRunRollingMigrationToRustStorage();

  // Stub addLoginsAsync to observe the second call
  const stub = sinon.stub(rustStorage, "addLoginsAsync");

  // Second migration - should not call addLoginAsync again
  await mirror.maybeRunRollingMigrationToRustStorage();

  Assert.ok(stub.notCalled, "Should skip unchanged login migration");

  mirror.disable();
  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
  stub.restore();
});

/**
 * Verify that the rolling migration:
 *  - continues when some rows fail (partial failure),
 *  - still migrates valid logins,
 *  - and sets the checkpoint at the end.
 */
// add_task(async function test_migration_partial_failure_sets_checkpoint() {
//   const login_ok = TestData.formLogin({
//     username: "test-user-ok",
//     password: "secure-password",
//   });
//   await Services.logins.addLoginAsync(login_ok);
//   const login_bad = TestData.formLogin({
//     username: "test-user-bad",
//     password: "secure-password",
//   });
//   await Services.logins.addLoginAsync(login_bad);
//
//   const rustStorage = new LoginManagerRustStorage();
//   await rustStorage.initialize();
//   const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
//
//   sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");
//   const setCpSpy = sinon.spy(rustStorage, "setCheckpoint");
//
//   // Save the first (valid) login into Rust for real, then simulate results
//   sinon.stub(rustStorage, "addLoginsAsync").callsFake(async (logins, _cont) => {
//     await rustStorage.addWithMeta(logins[0]);
//     return [
//       { login: {}, error: null }, // row 0 success
//       { login: null, error: { message: "row failed" } }, // row 1 failure
//     ];
//   });
//
//   try {
//     await mirror.enable();
//     const rustLogins = await rustStorage.getAllLogins();
//     Assert.equal(rustLogins.length, 1, "only valid login migrated");
//     Assert.ok(setCpSpy.calledOnce, "checkpoint was set");
//   } finally {
//     mirror.disable();
//     sinon.restore();
//     await LoginTestUtils.clearData();
//     rustStorage.removeAllLogins();
//   }
// });

/**
 * Verify that when the bulk add operation rejects (hard failure),
 * the migration itself rejects and no checkpoint is written.
 */
add_task(async function test_migration_rejects_when_bulk_add_rejects() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();
  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);

  //force the bulk add to fail
  sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");
  sinon.stub(rustStorage, "addLoginsAsync").rejects(new Error("bulk failed"));
  const setCheckpointSpy = sinon.spy(rustStorage, "setCheckpoint");

  try {
    await mirror.enable();
    await Assert.rejects(
      mirror.maybeRunRollingMigrationToRustStorage(),
      /bulk failed/,
      "migration should propagate a hard failure (bulk reject)"
    );

    // After a hard failure, no checkpoint must be set.
    Assert.ok(
      setCheckpointSpy.notCalled,
      "checkpoint must not be set on hard failure"
    );
  } finally {
    mirror.disable();
    sinon.restore();
    await LoginTestUtils.clearData();
    rustStorage.removeAllLogins();
  }
});

/**
 * Verify that if writing the checkpoint throws an error,
 * the migration rejects instead of silently succeeding.
 */
add_task(async function test_migration_rejects_when_setCheckpoint_throws() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();
  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();

  // Force migration always
  sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");
  // Force failure on checkpoint write
  sinon.stub(rustStorage, "setCheckpoint").throws(new Error("cp failed"));

  try {
    await Assert.rejects(
      mirror.maybeRunRollingMigrationToRustStorage(),
      /cp failed/,
      "migration should reject when setCheckpoint throws"
    );
  } finally {
    mirror.disable();
    sinon.restore();
    await LoginTestUtils.clearData();
    rustStorage.removeAllLogins();
  }
});

/**
 * Ensures that migrating a large number of logins (100) from the JSON store to
 * the Rust store completes within a reasonable time frame (under 1 second).
 **/
add_task(async function test_migration_time_under_threshold() {
  const numberOfLogins = 100;
  Services.prefs.setBoolPref("signon.loginsRustMirror.enabled", false);

  const logins = Array.from({ length: numberOfLogins }, (_, i) =>
    TestData.formLogin({
      origin: `https://www${i}.example.com`,
      username: `user${i}`,
    })
  );
  await Services.logins.addLogins(logins);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  Services.prefs.setBoolPref("signon.loginsRustMirror.enabled", true);
  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  const stub = sinon
    .stub(rustStorage, "getCheckpoint")
    .returns("force-migration");

  const start = Date.now();
  await mirror.maybeRunRollingMigrationToRustStorage();
  const duration = Date.now() - start;

  Assert.less(duration, 1000, "Migration should complete under 1s");

  Assert.equal(rustStorage.countLogins("", "", ""), numberOfLogins);

  mirror.disable();
  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
  stub.restore();
});

/*
 * Tests that the number of saved logins is appropriately reported to
 * the rust storage.
 */
add_task(async function test_logins_diff_count_rust_storage() {
  Services.fog.testResetFOG();
  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();

  // Add login to JSON store
  const login = TestData.formLogin({ username: "glean_user" });
  await Services.logins.addLoginAsync(login);

  await mirror.maybeRunRollingMigrationToRustStorage();

  // Force a migration by stubbing the checkpoint
  sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");
  const expectedDiff = 0;

  await mirror.maybeRunRollingMigrationToRustStorage();

  Assert.equal(
    Glean.pwmgr.diffSavedPasswordsRust.testGetValue(),
    expectedDiff,
    "Rust and JSON storage should have the same number of saved passwords"
  );

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/*
 * Tests that an error is logged when adding an invalid login to the Rust store.
 * The Rust store is stricter than the JSON store and rejects some formats,
 * such as certain non-ASCII origins.
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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

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

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

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

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

/*
 * Tests that we collect telemetry if non-ASCII formorigins get punycoded.
 */
add_task(async function test_punycode_formActionOrigin_metric() {
  Services.fog.testResetFOG();

  const punicodeFormOrigin = "https://münich.example.com";
  const login = LoginTestUtils.testData.formLogin({
    origin: "https://example.com",
    formActionOrigin: punicodeFormOrigin,
    username: "user1",
    password: "pass1",
  });

  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(
    allLogins.length,
    1,
    "punicode form action origin login saved to Rust"
  );
  const [rustLogin] = allLogins;
  Assert.equal(
    rustLogin.formActionOrigin,
    "https://xn--mnich-kva.example.com",
    "form action origin has been punicoded on the Rust side"
  );

  const evt =
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiFormAction.testGetValue();
  Assert.equal(evt, 1, "event has been emitted");

  await LoginTestUtils.clearData();
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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const evt = Glean.pwmgr.rustIncompatibleLoginFormat.dotOrigin.testGetValue();
  Assert.equal(evt, 1, "event has been emitted");

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});
