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

function recordMigrationPerformance(durationMs, totalLogins) {
  Glean.pwmgr.rustMigrationPerformance.record({
    duration_ms: String(durationMs),
    total_logins: String(totalLogins),
  });
}

export class LoginManagerRustMirror {
  #logger = null;
  #jsonStorage = null;
  #rustStorage = null;
  #isEnabled = false;
  #migrationInProgress = false;
  #observer = null;

  constructor(jsonStorage, rustStorage) {
    this.#logger = lazy.LoginHelper.createLogger("LoginManagerRustMirror");
    this.#jsonStorage = jsonStorage;
    this.#rustStorage = rustStorage;

    Services.prefs.addObserver("signon.rustMirror.migrationNeeded", () =>
      this.#maybeRunMigration(this)
    );

    Services.prefs.addObserver("signon.rustMirror.enabled", () =>
      this.#maybeEnable(this)
    );

    this.#logger.log("Rust Mirror is ready.");

    this.#maybeRunMigration().then(() => this.#maybeEnable());
  }

  #removeJsonStoreObserver() {
    if (this.#observer) {
      Services.obs.removeObserver(
        this.#observer,
        "passwordmgr-storage-changed"
      );
      this.#observer = null;
    }
  }

  #addJsonStoreObserver() {
    if (!this.#observer) {
      this.#observer = (subject, _, eventName) =>
        this.#onJsonStorageChanged(eventName, subject);
      Services.obs.addObserver(this.#observer, "passwordmgr-storage-changed");
    }
  }

  #maybeEnable() {
    const enabled =
      Services.prefs.getBoolPref("signon.rustMirror.enabled", true) &&
      !lazy.LoginHelper.isPrimaryPasswordSet();

    return enabled ? this.enable() : this.disable();
  }

  async enable() {
    if (this.#isEnabled) {
      return;
    }

    this.#removeJsonStoreObserver();

    try {
      await this.#maybeRunMigration();
      this.#addJsonStoreObserver();
      this.#isEnabled = true;
      this.#logger.log("Rust Mirror is enabled.");
    } catch (e) {
      this.#logger.error("Login migration failed", e);
      recordMigrationFailure("rolling-migration", e);
    }
  }

  disable() {
    if (!this.#isEnabled) {
      return;
    }

    this.#removeJsonStoreObserver();

    this.#isEnabled = false;
    this.#logger.log("Rust Mirror is disabled.");

    // Since we'll miss updates we'll need to migrate again
    Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", true);
  }

  // note there is no event fired when the primary password is set or unset, so
  // a check is needed on every event
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

    if (this.#migrationInProgress) {
      this.#logger.log(`Migration in progress, skipping event ${eventName}`);
      return;
    }

    switch (eventName) {
      case "addLogin":
        this.#logger.log(`adding login ${subject.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          await this.#rustStorage.addLoginsAsync([subject]);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
          this.#logger.log(`added login ${subject.guid}.`);
        } catch (e) {
          this.#logger.error("mirror-error:", e);
          recordMigrationFailure("add", e);
        }
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.#logger.log(`modifying login ${loginToModify.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          this.#rustStorage.modifyLogin(loginToModify, newLoginData);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
          this.#logger.log(`modified login ${loginToModify.guid}.`);
        } catch (e) {
          this.#logger.error("error: modifyLogin:", e);
          recordMigrationFailure("modify-login", e);
        }
        break;

      case "removeLogin":
        this.#logger.log(`removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
          this.#logger.log(`removed login ${subject.guid}.`);
        } catch (e) {
          this.#logger.error("error: removeLogin:", e);
          recordMigrationFailure("remove-login", e);
        }
        break;

      case "removeAllLogins":
        this.#logger.log("removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
          this.#logger.log("removed all logins.");
        } catch (e) {
          this.#logger.error("error: removeAllLogins:", e);
        }
        break;

      case "importLogins":
        this.#logger.log("ignoring importLogins message");
        break;

      default:
        this.#logger.error(`error: received unhandled event "${eventName}"`);
    }
  }

  async #maybeRunMigration() {
    if (this.#migrationInProgress) {
      this.#logger.log("Migration already in progress.");
      return;
    }

    const migrationNeeded = Services.prefs.getBoolPref(
      "signon.rustMirror.migrationNeeded",
      false
    );

    // eg in case a primary password has been set after enabling
    if (!migrationNeeded) {
      this.#logger.log("No migration needed.");
      return;
    }

    this.#logger.log("Migration is needed, migrating...");

    // We ignore events during erolling migration run. Once we switch the
    // stores over, we will run an initial migration again to ensure
    // consistancy.
    this.#migrationInProgress = true;

    // wait until loaded
    await this.#jsonStorage.initializationPromise;

    const t0 = Date.now();
    let totalLogins = 0;

    try {
      this.#rustStorage.removeAllLogins();
      this.#logger.log("Cleared existing Rust logins.");

      const logins = await this.#jsonStorage.getAllLogins();
      totalLogins = logins.length;

      const results = await this.#rustStorage.addLoginsAsync(logins, true);
      for (const { error } of results) {
        if (error) {
          this.#logger.error("error during rolling migration:", error);
          recordMigrationFailure("add", error);
        }
      }

      this.#logger.log(`Successfully migrated ${logins.length} logins.`);

      // Migration complete, don't run again
      Services.prefs.setBoolPref("signon.rustMirror.migrationNeeded", false);

      this.#logger.log("Migration complete.");
    } catch (e) {
      this.#logger.error("migration error:", e);
    } finally {
      const duration = Date.now() - t0;
      recordMigrationPerformance(duration, totalLogins);
      this.#migrationInProgress = false;
    }
  }
}
