const chromep = new ChromePromise();
itemName = `item_name=${encodeURIComponent("Supreme Ext")}`;


class ActivationManager {
  constructor() {
    // Should use this to control functions in the program based on whether
    // or not the extension is activated.
    this.isActivated = false;

    // How often in seconds to recheck the registration with the server.
    // Lower = higher server load
    this.registryRecheckIntervalSeconds = 43200; // 12 hours
    this.logger = console.log;

    this.instanceID = null;
    this.registrationKey = null;
    this.isRegistered = false;
    this.lastRegisteredCheckTime = null;

    Object.keys(this)
      .filter(k => k !== "logger")
      .filter(k => typeof this[k] === "function")
      .forEach(k => {
        console.log(k); // eslint-disable-line no-console
        this[k] = this[k].bind(this);
      });
  }

  // Start public methods
  // Event handlers
  onActivation(cb) {
    this.handleActivation = cb;
  }
  onDeactivation(cb) {
    this.handleDeactivation = cb;
  }
  onBeginActivationRequest(cb) {
    this.handleBeginActivationRequest = cb;
  }
  onEndActivationRequest(cb) {
    this.handleEndActivationRequest = cb;
  }
  onNoActivationsLeft(cb) {
    this.handleNoActivationsLeft = cb;
  }
  onRequestDeactivation(cb) {
    this.handleRequestDeactivation = cb;
  }
  onInvalidLicense(cb) {
    this.handleInvalidLicense = cb;
  }

  // Kicks off the activation check at the beginning of the program.
  verifyActivation() {
    this.verifyWasActivated()
      .then(() => this.verifyNotExpired())
      .then(() => {
        this.logger("verifyIsActivated: true");
        this.isActivated = true;
        if (this.handleActivation) this.handleActivation();
      })
      .catch(() => {
        this.logger("verifyIsActivated: false");
        this.isActivated = false;
        if (this.handleDeactivation) this.handleDeactivation();
      });
  }

  // Start user initiated activation request
  async requestActivation(license) {
    this.logger(`requestActivation: ${license}`);
    if (this.handleBeginActivationRequest) this.handleBeginActivationRequest();
    const instanceID = await this.getInstanceID();
    const licenseActivateURL = this.createLicenseRequestUrl(
      "activate_license",
      instanceID,
      license
    );
    const res = await fetch(licenseActivateURL);
    const data = await res.json();

    if (data.error === "no_activations_left") {
      if (this.handleNoActivationsLeft) this.handleNoActivationsLeft();
      // this.handleNoActivationsLeft(async () => {
      //   await this.resetActivations(license);
      //   await this.requestActivation(license);
      // });
      return;
    }

    if (data.error) {
      this.handleInvalidLicense();
    }

    if (data.license === "valid") {
      await this.activate(license);
    }

    if (this.handleEndActivationRequest) this.handleEndActivationRequest();
  }

  async requestDeactivation() {
    const deactivateInstall = async () => {
      const instanceID = await this.getInstanceID();
      const license = await this.getRegistrationKey();
      const licenseDeactivateUrl = this.createLicenseRequestUrl(
        "deactivate_license",
        instanceID,
        license
      );
      await fetch(licenseDeactivateUrl);
      await this.deactivate();
    };
    this.handleRequestDeactivation(deactivateInstall);
  }
  // End public methods

  async activate(license) {
    this.isActivated = true;

    this.registrationKey = license;
    this.lastRegisteredCheckTime = new Date();
    this.lastRegisteredCheckTime = this.lastRegisteredCheckTime.getTime();
    const timestampKey = await this.getRegistrationTimestampKey();
    const registrationStorageKey = await this.getRegistrationStorageKey();

    await chromep.storage.sync.set({
      [timestampKey]: this.lastRegisteredCheckTime,
      registrationKey: license,
      [registrationStorageKey]: true
    });

    if (this.handleActivation) this.handleActivation();
  }

  async deactivate() {
    this.isActivated = false;

    const timestampKey = await this.getRegistrationTimestampKey();
    const registrationStorageKey = await this.getRegistrationStorageKey();
    await chromep.storage.sync.remove([timestampKey, registrationStorageKey]);
    this.registrationKey = null;
    this.lastRegisteredCheckTime = null;

    if (this.handleDeactivation) this.handleDeactivation();
  }

  async resetActivations(license) {
    const values = await chromep.storage.sync.get(null);
    console.log("resetActivations", values); // eslint-disable-line no-console
    const instances = Object.keys(values)
      .filter(v => v.indexOf("registration#") === 0)
      .map(v => v.slice("registration#".length));
    const requestUrls = instances.map(i =>
      createLicenseRequestUrl("deactivate_license", i, license)
    );
    const requests = requestUrls.map(r => fetch(r));
    return Promise.all(requests);
  }

  createLicenseRequestUrl(action, instanceID, license) {
    action = `edd_action=${action}`;
    const itemName = itemName;
    license = `license=${license}`;
    const url = `url=${instanceID}`;
    const licenseCheckURL = `http://secure-cop.com?${action}&${itemName}&${license}&${url}`;
    this.logger(`createLicenseRequestUrl: ${licenseCheckURL}`);
    return licenseCheckURL;
  }

  // Get the cached InstanceID or request it from the browser
  async getInstanceID() {
    if (this.instanceID) return this.instanceID;
    this.instanceID = await chromep.instanceID.getID();
    return this.instanceID;
  }

  // Get the cached registration key or request it from synced storage
  async getRegistrationKey() {
    if (this.registrationKey) return this.registrationKey;
    const { registrationKey } = await chromep.storage.sync.get(
      "registrationKey"
    );
    if (!registrationKey) throw new Error("no registration key found");
    this.registrationKey = registrationKey;
    return registrationKey;
  }

  // Generate a key name for storing registration state related to individual
  // extension installations.
  async getRegistrationStorageKey() {
    const instanceID = await this.getInstanceID();
    return `registration#${instanceID}`;
  }

  // Return the key name used for storing the last checked time for
  // registration.
  async getRegistrationTimestampKey() {
    const registrationStorageKey = await this.getRegistrationStorageKey();
    return `${registrationStorageKey}#timestamp`;
  }

  // Get the cached activation state or retrieve it from synced storage. This
  // is a value indicating that this extension installation was activated with
  // the activation server at some point.
  verifyWasActivated() {
    return new Promise((resolve, reject) => {
      if (this.isRegistered) {
        this.logger("verifyWasActivated: cached: true");
        resolve();
        return;
      }

      this.getRegistrationStorageKey().then(registrationStorageKey => {
        chrome.storage.sync.get(registrationStorageKey, values => {
          if (!values[registrationStorageKey]) {
            this.logger("verifyWasActivated: none: rejecting");
            reject();
            return;
          }

          this.isRegistered = true;
          this.logger("verifyWasActivated: fresh");
          resolve();
        });
      });
    });
  }

  // Get the cached time that this extension installation was last verified
  // with the server. Retrieve from synced storage if not cached. This is used
  // to perform periodic status checks to determine whether or not the
  // extension is still activated on particular installations.
  verifyNotExpired() {
    const isExpired = timestamp => {
      // prettier-ignore
      let elapsed = (new Date()).getTime() - timestamp;
      elapsed /= 1000;
      elapsed = Math.round(elapsed % 60);
      const expired = elapsed > this.registryRecheckIntervalSeconds;
      this.logger(
        `isExpired: timeStamp->${+timestamp}: elapsed->${elapsed}: expired->${expired}`
      );
      return expired;
    };

    return new Promise((resolve, reject) => {
      const checkExpiration = timestamp => {
        if (isExpired(timestamp)) {
          this.logger(`checkExpiration: expired: ${timestamp}`);
          this.getRegistrationKey().then(async license => {
            const instanceID = await this.getInstanceID();
            const checkLicenseUrl = this.createLicenseRequestUrl(
              "check_license",
              instanceID,
              license
            );
            const res = await fetch(checkLicenseUrl);
            const data = await res.json();
            if (data.license === "valid") {
              this.lastRegisteredCheckTime = new Date();
              this.lastRegisteredCheckTime = this.lastRegisteredCheckTime.getTime();
              const timestampKey = await this.getRegistrationTimestampKey();
              await chromep.storage.sync.set({
                [timestampKey]: this.lastRegisteredCheckTime
              });
              resolve();
              return;
            }
            reject();
          });
        }
        this.logger("checkExpiration: not expired");
        resolve();
      };

      if (this.lastRegisteredCheckTime) {
        this.logger(
          `verifyNotExpired: cached: ${this.lastRegisteredCheckTime}`
        );
        checkExpiration(this.lastRegisteredCheckTime);
        return;
      }

      this.getRegistrationTimestampKey().then(timestampKey => {
        chrome.storage.sync.get(timestampKey, values => {
          if (!values[timestampKey]) {
            this.logger("verifyNotExpired: none: rejecting");
            reject();
            return;
          }

          this.lastRegisteredCheckTime = values[timestampKey];
          this.logger(
            `verifyNotExpired: retrieved: ${this.lastRegisteredCheckTime}`
          );
          checkExpiration(this.lastRegisteredCheckTime);
        });
      });
    });
  }
}
