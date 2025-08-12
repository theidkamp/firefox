/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

/* Check if an url has punicode encoded hostname */
function isPunycode(origin) {
  try {
    return origin && new URL(origin).hostname.startsWith("xn--");
  } catch (_) {
    return false;
  }
}

function recordPasswordCountDiff(jsonStorage, rustStorage) {
  const jsonCount = jsonStorage.countLogins("", "", "");
  const rustCount = rustStorage.countLogins("", "", "");
  const diff = jsonCount - rustCount;
  Glean.pwmgr.diffSavedPasswordsRust.set(diff);
}

function recordIncompatibleFormats(loginInfo) {
  if (isPunycode(loginInfo.origin)) {
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiOrigin.add();
  }
  if (isPunycode(loginInfo.formActionOrigin)) {
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiFormAction.add();
  }

  if (loginInfo.origin === ".") {
    Glean.pwmgr.rustIncompatibleLoginFormat.dotOrigin.add();
  }
}

function recordMigrationFailure(operation, error) {
  Glean.pwmgr.rustMigrationFailure.record({
    operation,
    error_message: error.message ?? String(error),
  });
}

export class LoginManagerRustMirror {
  #logger = null;
  #jsonStorage = null;
  #rustStorage = null;
  #isEnabled = false;
  #rollingMigrationInProgress = false;
  #observer = null;

  constructor(jsonStorage, rustStorage) {
    this.#logger = lazy.LoginHelper.createLogger("LoginManagerRustMirror");
    this.#jsonStorage = jsonStorage;
    this.#rustStorage = rustStorage;
  }

  #removeObserver() {
    if (this.#observer) {
      Services.obs.removeObserver(
        this.#observer,
        "passwordmgr-storage-changed"
      );
      this.#observer = null;
    }
  }

  #addObserver() {
    if (!this.#observer) {
      this.#observer = (subject, _, eventName) =>
        this.#onJsonStorageChanged(eventName, subject);
      Services.obs.addObserver(this.#observer, "passwordmgr-storage-changed");
    }
  }

  async enable() {
    if (this.#isEnabled) {
      return;
    }

    this.#removeObserver();

    try {
      await this.maybeRunRollingMigrationToRustStorage();
    } catch (e) {
      this.#logger.error("Login migration failed", e);
      recordMigrationFailure("rolling-migration", e);
    }

    this.#addObserver();

    this.#isEnabled = true;
  }

  disable() {
    if (!this.#isEnabled) {
      return;
    }

    this.#removeObserver();

    this.#isEnabled = false;
  }

  get #isActive() {
    return this.#isEnabled && !lazy.LoginHelper.isPrimaryPasswordSet();
  }

  async #onJsonStorageChanged(eventName, subject) {
    this.#logger.log(`received change event ${eventName}...`);

    // eg in case a primary password has been set after enabling
    if (!this.#isActive) {
      this.#logger.log("Mirror is not active. Change will not be mirrored.");
      return;
    }

    if (this.#rollingMigrationInProgress) {
      this.#logger.log("Rolling migration in progress, skipping event.");
      return;
    }

    switch (eventName) {
      case "addLogin":
        this.#logger.log(`adding login ${subject.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          await this.#rustStorage.addLoginsAsync([subject]);
          await this.#storeCurrentCheckpoint();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          this.#logger.error("mirror-error:", e);
          recordMigrationFailure("add", e);
        }
        this.#logger.log(`added login ${subject.guid}.`);
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.#logger.log(`modifying login ${loginToModify.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          this.#rustStorage.modifyLogin(loginToModify, newLoginData);
          await this.#storeCurrentCheckpoint();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          this.#logger.error("error: modifyLogin:", e);
          recordMigrationFailure("modify-login", e);
        }
        this.#logger.log(`modified login ${loginToModify.guid}.`);
        break;

      case "removeLogin":
        this.#logger.log(`removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);
          await this.#storeCurrentCheckpoint();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          this.#logger.error("error: removeLogin:", e);
          recordMigrationFailure("remove-login", e);
        }
        this.#logger.log(`removed login ${subject.guid}.`);
        break;

      case "removeAllLogins":
        this.#logger.log("removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();
          await this.#storeCurrentCheckpoint();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          this.#logger.error("error: removeAllLogins:", e);
          recordMigrationFailure("remove-all-logins", e);
        }
        this.#logger.log("removed all logins.");
        break;

      default:
        this.#logger.error(`error: received unhandled event "${eventName}"`);
    }
  }

  async #storeCurrentCheckpoint() {
    const jsonChecksum = await this.#jsonStorage.computeSha256();
    return this.#rustStorage.setCheckpoint(jsonChecksum);
  }

  async maybeRunRollingMigrationToRustStorage() {
    this.#logger.log("Checking whether migration is needed.");

    // eg in case a primary password has been set after enabling
    if (!this.#isActive) {
      this.#logger.log("Mirror is not active. No migration needed..");
      return;
    }

    this.#rollingMigrationInProgress = true;

    // wait until loaded
    await this.#jsonStorage.initializationPromise;
    this.#logger.log("Running login migration...");

    const jsonChecksum = await this.#jsonStorage.computeSha256();
    const rustCheckpoint = this.#rustStorage.getCheckpoint();

    if (!jsonChecksum) {
      this.#logger.log("Empty json store. No migration needed.");
      return;
    }

    if (jsonChecksum === rustCheckpoint) {
      this.#logger.log("Checksums match. No migration needed.");
      return;
    }

    this.#logger.log("Checksums differ. Rolling migration required.");

    try {
      this.#rustStorage.removeAllLogins();
      this.#logger.log("Cleared existing Rust logins.");

      const logins = await this.#jsonStorage.getAllLogins();

      const results = await this.#rustStorage.addLoginsAsync(logins, true);
      for (const { error } of results) {
        if (error) {
          this.#logger.error("error during rolling migration:", error);
          recordMigrationFailure("add", error);
        }
      }

      this.#logger.log(`Successfully migrated ${logins.length} logins.`);

      this.#rustStorage.setCheckpoint(jsonChecksum);
      this.#logger.log("Migration complete. Checkpoint updated.");

      this.#logger.log("Login migration finished.");
    } finally {
      this.#rollingMigrationInProgress = false;
    }
  }
}
