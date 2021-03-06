// This module monitors Expiring Multi Party contracts and produce logs when: 1) new sponsors are detected,
// 2) liquidations are submitted, 3) liquidations are disputed or 4) disputes are resolved.

const {
  ConvertDecimals,
  createFormatFunction,
  createEtherscanLinkMarkdown,
  revertWrapper,
  createObjectFromDefaultProps
} = require("@uma/common");

class ContractMonitor {
  /**
  * @notice Constructs new contract monitor module.
   * @param {Object} logger Winston module used to send logs.
   * @param {Object} expiringMultiPartyEventClient Client used to query EMP events for contract state updates.
   * @param {Object} priceFeed Module used to query the current token price.
   * @param {Object} monitorConfig Object containing two arrays of monitored liquidator and disputer bots to inform logs Example:
   *      { "monitoredLiquidators": ["0x1234","0x5678"],
   *        "monitoredDisputers": ["0x1234","0x5678"] }
   * @param {Object} empProps Configuration object used to inform logs of key EMP information. Example:
   *      { collateralSymbol: "DAI",
            syntheticSymbol:"ETHBTC",
            priceIdentifier: "ETH/BTC",
            collateralDecimals: 18,
            syntheticDecimals: 18,
            priceFeedDecimals: 18,
            networkId:1 }
   * @param {Object} votingContract DVM to query price requests.
   */
  constructor({ logger, expiringMultiPartyEventClient, priceFeed, monitorConfig, empProps, votingContract }) {
    this.logger = logger;

    // Offchain price feed to get the price for liquidations.
    this.priceFeed = priceFeed;

    // EMP event client to read latest contract events.
    this.empEventClient = expiringMultiPartyEventClient;
    this.empContract = this.empEventClient.emp;
    this.web3 = this.empEventClient.web3;

    // Voting contract to query resolved prices.
    this.votingContract = votingContract;

    // Previous contract state used to check for new entries between calls.
    this.lastLiquidationBlockNumber = 0;
    this.lastDisputeBlockNumber = 0;
    this.lastDisputeSettlementBlockNumber = 0;
    this.lastNewSponsorBlockNumber = 0;

    // Define a set of normalization functions. These Convert a number delimited with given base number of decimals to a
    // number delimited with a given number of decimals (18). For example, consider normalizeCollateralDecimals. 100 BTC
    // is 100*10^8. This function would return 100*10^18, thereby converting collateral decimals to 18 decimal places.
    this.normalizeCollateralDecimals = ConvertDecimals(empProps.collateralDecimals, 18, this.web3);
    this.normalizeSyntheticDecimals = ConvertDecimals(empProps.syntheticDecimals, 18, this.web3);
    this.normalizePriceFeedDecimals = ConvertDecimals(empProps.priceFeedDecimals, 18, this.web3);

    // Formats an 18 decimal point string with a define number of decimals and precision for use in message generation.
    this.formatDecimalString = createFormatFunction(this.web3, 2, 4, false);

    // Bot and ecosystem accounts to monitor, overridden by monitorConfig parameter.
    const defaultConfig = {
      // By default monitor no liquidator bots (empty array).
      monitoredLiquidators: {
        value: [],
        isValid: x => {
          // For the config to be valid it must be an array of address.
          return Array.isArray(x) && x.every(y => this.web3.utils.isAddress(y));
        }
      },
      monitoredDisputers: {
        value: [],
        isValid: x => {
          // For the config to be valid it must be an array of address.
          return Array.isArray(x) && x.every(y => this.web3.utils.isAddress(y));
        }
      },
      logOverrides: {
        // Specify an override object to change default logging behaviour. Defaults to no overrides. If specified, this
        // object is structured to contain key for the log to override and value for the logging level. EG:
        // { newPositionCreated:'debug' } would override the default `info` behaviour for newPositionCreated.
        value: {},
        isValid: overrides => {
          // Override must be one of the default logging levels: ['error','warn','info','http','verbose','debug','silly']
          return Object.values(overrides).every(param => Object.keys(this.logger.levels).includes(param));
        }
      }
    };

    Object.assign(this, createObjectFromDefaultProps(monitorConfig, defaultConfig));

    // Validate the EMPProps object. This contains a set of important info within it so need to be sure it's structured correctly.
    const defaultEmpProps = {
      empProps: {
        value: {},
        isValid: x => {
          // The config must contain the following keys and types:
          return (
            Object.keys(x).includes("collateralSymbol") &&
            typeof x.collateralSymbol === "string" &&
            Object.keys(x).includes("syntheticSymbol") &&
            typeof x.syntheticSymbol === "string" &&
            Object.keys(x).includes("priceIdentifier") &&
            typeof x.priceIdentifier === "string" &&
            Object.keys(x).includes("collateralDecimals") &&
            typeof x.collateralDecimals === "number" &&
            Object.keys(x).includes("syntheticDecimals") &&
            typeof x.syntheticDecimals === "number" &&
            Object.keys(x).includes("priceFeedDecimals") &&
            typeof x.priceFeedDecimals === "number" &&
            Object.keys(x).includes("networkId") &&
            typeof x.networkId === "number"
          );
        }
      }
    };
    Object.assign(
      this,
      createObjectFromDefaultProps(
        {
          empProps
        },
        defaultEmpProps
      )
    );

    // Helper functions from web3.
    this.toWei = this.web3.utils.toWei;
    this.toBN = this.web3.utils.toBN;
    this.utf8ToHex = this.web3.utils.utf8ToHex;

    this.fixedPointAdjustment = this.toBN(this.toWei("1"));
  }

  // Quries NewSponsor events since the latest query marked by `lastNewSponsorBlockNumber`.
  async checkForNewSponsors() {
    this.logger.debug({
      at: "ContractMonitor",
      message: "Checking for new sponsor events",
      lastNewSponsorBlockNumber: this.lastNewSponsorBlockNumber
    });

    // Get the latest new sponsor information.
    let latestNewSponsorEvents = this.empEventClient.getAllNewSponsorEvents();

    // Get events that are newer than the last block number we've seen
    let newSponsorEvents = latestNewSponsorEvents.filter(event => event.blockNumber > this.lastNewSponsorBlockNumber);

    for (let event of newSponsorEvents) {
      // Check if new sponsor is UMA bot.
      const isLiquidatorBot = this.monitoredLiquidators.indexOf(event.sponsor);
      const isDisputerBot = this.monitoredDisputers.indexOf(event.sponsor);
      const isMonitoredBot = Boolean(isLiquidatorBot != -1 || isDisputerBot != -1);

      // Sample message:
      // New sponsor alert: [ethereum address if third party, or “UMA” if it’s our bot]
      // created X tokens backed by Y collateral.  [etherscan link to txn]
      const mrkdwn =
        createEtherscanLinkMarkdown(event.sponsor, this.empProps.networkId) +
        (isMonitoredBot ? " (Monitored liquidator or disputer bot)" : "") +
        " created " +
        this.formatDecimalString(this.normalizeSyntheticDecimals(event.tokenAmount)) +
        " " +
        this.empProps.syntheticSymbol +
        " backed by " +
        this.formatDecimalString(this.normalizeCollateralDecimals(event.collateralAmount)) +
        " " +
        this.empProps.collateralSymbol +
        ". tx: " +
        createEtherscanLinkMarkdown(event.transactionHash, this.empProps.networkId);

      this.logger[this.logOverrides.newPositionCreated || "info"]({
        at: "ContractMonitor",
        message: "New Sponsor Alert 🐣!",
        mrkdwn: mrkdwn
      });
    }
    this.lastNewSponsorBlockNumber = this._getLastSeenBlockNumber(latestNewSponsorEvents);
  }

  // Queries disputable liquidations and disputes any that were incorrectly liquidated.
  async checkForNewLiquidations() {
    this.logger.debug({
      at: "ContractMonitor",
      message: "Checking for new liquidation events",
      lastLiquidationBlockNumber: this.lastLiquidationBlockNumber
    });

    // Get the latest liquidation information.
    let latestLiquidationEvents = this.empEventClient.getAllLiquidationEvents();

    // Get liquidation events that are newer than the last block number we've seen
    let newLiquidationEvents = latestLiquidationEvents.filter(
      event => event.blockNumber > this.lastLiquidationBlockNumber
    );

    for (let event of newLiquidationEvents) {
      const liquidationTime = (await this.web3.eth.getBlock(event.blockNumber)).timestamp;
      const historicalLookbackWindow =
        Number(this.priceFeed.getLastUpdateTime()) - Number(this.priceFeed.getLookback());

      // If liquidation time is before the earliest possible historical price, then we can skip this liquidation
      // because we will not be able to get a historical price.
      if (liquidationTime < historicalLookbackWindow) {
        this.logger.debug({
          at: "Disputer",
          message: "Cannot get historical price: liquidation time before earliest price feed historical timestamp",
          liquidationTime,
          historicalLookbackWindow
        });
        continue;
      }

      // If liquidation time is before historical lookback window, then we can skip this liquidation
      // because we will not be able to get a historical price.
      if (liquidationTime < this.priceFeed.getLastUpdateTime() - this.priceFeed.getLookback()) {
        this.logger.debug({
          at: "Disputer",
          message: "Cannot get historical price: liquidation time before earliest price feed historical timestamp",
          liquidationTime,
          priceFeedEarliestTime: this.priceFeed.getLastUpdateTime() - this.priceFeed.getLookback()
        });
        continue;
      }

      const price = this.priceFeed.getHistoricalPrice(parseInt(liquidationTime.toString()));
      let collateralizationString;
      let maxPriceToBeDisputableString;
      const crRequirement = await this.empContract.methods.collateralRequirement().call();
      let crRequirementString = this.toBN(crRequirement).muln(100);
      if (price) {
        collateralizationString = this.formatDecimalString(
          this._calculatePositionCRPercent(event.liquidatedCollateral, event.tokensOutstanding, price)
        );
        maxPriceToBeDisputableString = this.formatDecimalString(
          this._calculateDisputablePrice(crRequirement, event.liquidatedCollateral, event.tokensOutstanding)
        );
      } else {
        this.logger.warn({
          at: "ContractMonitor",
          message: "Could not get historical price for liquidation",
          price,
          liquidationTime: liquidationTime.toString()
        });
        collateralizationString = "[Invalid]";
        maxPriceToBeDisputableString = "[Invalid]";
      }

      // Sample message:
      // Liquidation alert: [ethereum address if third party, or “UMA” if it’s our bot]
      // initiated liquidation for for [x][collateral currency] (liquidated collateral = [y]) of sponsor collateral
      // backing[n] tokens. Sponsor collateralization was[y] %, using [p] as the estimated price at liquidation time.
      // With a collateralization requirement of [r]%, this liquidation would be disputable at a price below [l]. [etherscan link to txn]
      let mrkdwn =
        createEtherscanLinkMarkdown(event.liquidator, this.empProps.networkId) +
        (this.monitoredLiquidators.indexOf(event.liquidator) != -1 ? " (Monitored liquidator bot)" : "") +
        " initiated liquidation for " +
        this.formatDecimalString(this.normalizeCollateralDecimals(event.lockedCollateral)) +
        " (liquidated collateral = " +
        this.formatDecimalString(this.normalizeCollateralDecimals(event.liquidatedCollateral)) +
        ") " +
        this.empProps.collateralSymbol +
        " of sponsor " +
        createEtherscanLinkMarkdown(event.sponsor, this.empProps.networkId) +
        " collateral backing " +
        this.formatDecimalString(this.normalizeSyntheticDecimals(event.tokensOutstanding)) +
        " " +
        this.empProps.syntheticSymbol +
        " tokens. ";
      // Add details about the liquidation price if historical data from the pricefeed is available.
      if (price) {
        mrkdwn +=
          "Sponsor collateralization was " +
          collateralizationString +
          "%. " +
          "Using " +
          this.formatDecimalString(this.normalizePriceFeedDecimals(price)) +
          " as the estimated price at liquidation time. With a collateralization requirement of " +
          this.formatDecimalString(crRequirementString) +
          "%, this liquidation would be disputable at a price below " +
          maxPriceToBeDisputableString +
          ". ";
      }
      // Add etherscan link.
      mrkdwn += `Tx: ${createEtherscanLinkMarkdown(event.transactionHash, this.empProps.networkId)}`;
      this.logger.info({
        at: "ContractMonitor",
        message: "Liquidation Alert 🧙‍♂️!",
        mrkdwn: mrkdwn
      });
    }
    this.lastLiquidationBlockNumber = this._getLastSeenBlockNumber(latestLiquidationEvents);
  }

  async checkForNewDisputeEvents() {
    this.logger.debug({
      at: "ContractMonitor",
      message: "Checking for new dispute events",
      lastDisputeBlockNumber: this.lastDisputeBlockNumber
    });

    // Get the latest dispute information.
    let latestDisputeEvents = this.empEventClient.getAllDisputeEvents();

    let newDisputeEvents = latestDisputeEvents.filter(event => event.blockNumber > this.lastDisputeBlockNumber);

    for (let event of newDisputeEvents) {
      // Sample message:
      // Dispute alert: [ethereum address if third party, or “UMA” if it’s our bot]
      // initiated dispute [etherscan link to txn]
      const mrkdwn =
        createEtherscanLinkMarkdown(event.disputer, this.empProps.networkId) +
        (this.monitoredDisputers.indexOf(event.disputer) != -1 ? " (Monitored dispute bot)" : "") +
        " initiated dispute against liquidator " +
        createEtherscanLinkMarkdown(event.liquidator, this.empProps.networkId) +
        (this.monitoredLiquidators.indexOf(event.liquidator) != -1 ? " (Monitored liquidator bot)" : "") +
        " with a dispute bond of " +
        this.formatDecimalString(this.normalizeCollateralDecimals(event.disputeBondAmount)) +
        " " +
        this.empProps.collateralSymbol +
        ". tx: " +
        createEtherscanLinkMarkdown(event.transactionHash, this.empProps.networkId);

      this.logger.info({
        at: "ContractMonitor",
        message: "Dispute Alert 👻!",
        mrkdwn: mrkdwn
      });
    }
    this.lastDisputeBlockNumber = this._getLastSeenBlockNumber(latestDisputeEvents);
  }

  async checkForNewDisputeSettlementEvents() {
    this.logger.debug({
      at: "ContractMonitor",
      message: "Checking for new dispute settlement events",
      lastDisputeSettlementBlockNumber: this.lastDisputeSettlementBlockNumber
    });

    // Get the latest disputeSettlement information.
    let latestDisputeSettlementEvents = this.empEventClient.getAllDisputeSettlementEvents();

    let newDisputeSettlementEvents = latestDisputeSettlementEvents.filter(
      event => event.blockNumber > this.lastDisputeSettlementBlockNumber
    );

    for (let event of newDisputeSettlementEvents) {
      let resolvedPrice;
      try {
        // Query resolved price for dispute price request. Note that this will return nothing if the
        // disputed liquidation's block timestamp is not equal to the timestamp of the price request. This could be the
        // the case if the EMP contract is using the Timer contract for example.
        const liquidationEvent = this.empEventClient
          .getAllLiquidationEvents()
          .find(_event => _event.sponsor === event.sponsor && _event.liquidationId === event.liquidationId);
        const liquidationTimestamp = (await this.web3.eth.getBlock(liquidationEvent.blockNumber)).timestamp;

        resolvedPrice = revertWrapper(
          await this.votingContract.getPrice(this.utf8ToHex(this.empProps.priceIdentifier), liquidationTimestamp, {
            from: this.empContract.options.address
          })
        );
      } catch (error) {
        // No price or matching liquidation available.
      }

      // Sample message:
      // Dispute settlement alert: Dispute between liquidator [ethereum address if third party,
      // or “UMA” if it’s our bot] and disputer [ethereum address if third party, or “UMA” if
      // it’s our bot]has resolved as [success or failed] [etherscan link to txn]
      let mrkdwn =
        "Dispute between liquidator " +
        createEtherscanLinkMarkdown(event.liquidator, this.empProps.networkId) +
        (this.monitoredLiquidators.indexOf(event.liquidator) != -1 ? " (Monitored liquidator bot)" : "") +
        " and disputer " +
        createEtherscanLinkMarkdown(event.disputer, this.empProps.networkId) +
        (this.monitoredDisputers.indexOf(event.disputer) != -1 ? " (Monitored dispute bot)" : "") +
        " has settled. ";
      // Add details about the resolved price request if available.
      if (resolvedPrice) {
        // NOTE: this will need to change back to formatDecimalString when the price feed is updated following
        // subsequent UMIPS.
        mrkdwn += `The disputed liquidation price resolved to: ${this.formatDecimalString(
          this.normalizePriceFeedDecimals(resolvedPrice)
        )}, which resulted in a ${event.disputeSucceeded ? "successful" : "failed"} dispute. `;
      } else {
        mrkdwn += `The disputed liquidation ${event.disputeSucceeded ? "succeeded" : "failed"}. `;
      }
      // Add etherscan link.
      mrkdwn += `Tx: ${createEtherscanLinkMarkdown(event.transactionHash, this.empProps.networkId)}`;
      this.logger.info({
        at: "ContractMonitor",
        message: "Dispute Settlement Alert 👮‍♂️!",
        mrkdwn: mrkdwn
      });
    }
    this.lastDisputeSettlementBlockNumber = this._getLastSeenBlockNumber(latestDisputeSettlementEvents);
  }

  // Calculate the collateralization Ratio from the collateral, token amount and token price.
  // This is found using the following equation cr = [collateral / (tokensOutstanding * price)] * 100.
  // The number returned is scaled by 1e18.
  _calculatePositionCRPercent(collateral, tokensOutstanding, tokenPrice) {
    return this.normalizeCollateralDecimals(collateral)
      .mul(this.fixedPointAdjustment.mul(this.fixedPointAdjustment))
      .div(this.normalizeSyntheticDecimals(tokensOutstanding).mul(this.normalizePriceFeedDecimals(tokenPrice)))
      .muln(100);
  }

  // Calculate the maximum price at which this liquidation would be disputable. This is found using the following
  // equation: liquidatedCollateral / (liquidatedTokens * crRequirement)
  _calculateDisputablePrice(crRequirement, liquidatedCollateral, liquidatedTokens) {
    return this.normalizeCollateralDecimals(liquidatedCollateral)
      .mul(this.fixedPointAdjustment.mul(this.fixedPointAdjustment))
      .div(this.normalizeSyntheticDecimals(liquidatedTokens).mul(this.toBN(crRequirement)));
  }

  _getLastSeenBlockNumber(eventArray) {
    if (eventArray.length == 0) {
      return 0;
    }
    return eventArray[eventArray.length - 1].blockNumber;
  }
}

module.exports = {
  ContractMonitor
};
