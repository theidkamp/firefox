/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

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
          await this.#rustStorage.addLoginsAsync([subject]);
          await this.#storeCurrentCheckpoint();
        } catch (e) {
          this.#logger.error("mirror-error:", e);
        }
        this.#logger.log(`added login ${subject.guid}.`);
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.#logger.log(`modifying login ${loginToModify.guid}...`);
        try {
          this.#rustStorage.modifyLogin(loginToModify, newLoginData);
          await this.#storeCurrentCheckpoint();
        } catch (e) {
          this.#logger.error("error: modifyLogin:", e);
        }
        this.#logger.log(`modified login ${loginToModify.guid}.`);
        break;

      case "removeLogin":
        this.#logger.log(`removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);
          await this.#storeCurrentCheckpoint();
        } catch (e) {
          this.#logger.error("error: removeLogin:", e);
        }
        this.#logger.log(`removed login ${subject.guid}.`);
        break;

      case "removeAllLogins":
        this.#logger.log("removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();
          await this.#storeCurrentCheckpoint();
        } catch (e) {
          this.#logger.error("error: removeAllLogins:", e);
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

      await this.#rustStorage.addLoginsAsync(logins, true);

      this.#logger.log(`Successfully migrated ${logins.length} logins.`);

      this.#rustStorage.setCheckpoint(jsonChecksum);
      this.#logger.log("Migration complete. Checkpoint updated.");

      this.#logger.log("Login migration finished.");
    } finally {
      this.#rollingMigrationInProgress = false;
    }
  }
}
