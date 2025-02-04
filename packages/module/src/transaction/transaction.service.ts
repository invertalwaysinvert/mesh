import { csl, largestFirst, largestFirstMultiAsset } from '@mesh/core';
import {
  DEFAULT_PROTOCOL_PARAMETERS, DEFAULT_REDEEMER_BUDGET,
  POLICY_ID_LENGTH, SUPPORTED_COST_MODELS,
} from '@mesh/common/constants';
import { IInitiator } from '@mesh/common/contracts';
import { Checkpoint, Trackable, TrackableObject } from '@mesh/common/decorators';
import {
  buildDataCost, buildDatumSource, buildMintWitness,
  buildPlutusScriptSource, buildTxBuilder, buildTxInputsBuilder,
  buildTxOutputBuilder, deserializeEd25519KeyHash, deserializeNativeScript,
  deserializePlutusScript, deserializeTx, fromScriptRef, fromTxUnspentOutput,
  fromUTF8, resolvePaymentKeyHash, resolveStakeKeyHash, toAddress, toBytes,
  toPoolParams, toRedeemer, toRewardAddress, toTxUnspentOutput, toValue,
} from '@mesh/common/utils';
import type {
  Address, Certificates, MintBuilder,
  TransactionBuilder, TxInputsBuilder, Withdrawals,
} from '@mesh/core';
import type {
  Action, Asset, AssetMetadata, Data, Era, Mint, Protocol,
  PlutusScript, Quantity, Recipient, Unit, UTxO, PoolParams,
} from '@mesh/common/types';

@Trackable
export class Transaction {
  private _changeAddress?: Address;
  private _recipients = new Map<Recipient, Asset[]>();
  private _totalBurns = new Map<Unit, Quantity>();
  private _totalMints = new Map<Unit, Mint>();

  private readonly _era?: Era;
  private readonly _initiator?: IInitiator;
  private readonly _mintBuilder: MintBuilder;
  private readonly _protocolParameters: Protocol;
  private readonly _txBuilder: TransactionBuilder;
  private readonly _txCertificates: Certificates;
  private readonly _txInputsBuilder: TxInputsBuilder;
  private readonly _txWithdrawals: Withdrawals;

  constructor(options = {} as Partial<CreateTxOptions>) {
    this._era = options.era;
    this._initiator = options.initiator;
    this._mintBuilder = csl.MintBuilder.new();
    this._protocolParameters = options.parameters ?? DEFAULT_PROTOCOL_PARAMETERS;
    this._txBuilder = buildTxBuilder(options.parameters);
    this._txCertificates = csl.Certificates.new();
    this._txInputsBuilder = csl.TxInputsBuilder.new();
    this._txWithdrawals = csl.Withdrawals.new();
  }

  static maskMetadata(cborTx: string, era: Era = 'ALONZO') {
    const tx = deserializeTx(cborTx);
    const txMetadata = tx.auxiliary_data()?.metadata();

    if (txMetadata !== undefined) {
      const mockMetadata = csl.GeneralTransactionMetadata.new();
      for (let index = 0; index < txMetadata.len(); index += 1) {
        const label = txMetadata.keys().get(index);
        const metadatum = txMetadata.get(label);

        mockMetadata.insert(
          label, csl.TransactionMetadatum.from_hex(
            '0'.repeat((metadatum?.to_hex() ?? '').length),
          ),
        );
      }

      const txAuxData = tx.auxiliary_data();

      if (txAuxData !== undefined) {
        txAuxData.set_metadata(mockMetadata);
        txAuxData.set_prefer_alonzo_format(
          era === 'ALONZO',
        );
      }

      return csl.Transaction.new(
        tx.body(), tx.witness_set(), txAuxData,
      ).to_hex();
    }

    return cborTx;
  }

  static readMetadata(cborTx: string) {
    const tx = deserializeTx(cborTx);
    return tx.auxiliary_data()?.metadata()?.to_hex() ?? '';
  }

  static writeMetadata(cborTx: string, cborTxMetadata: string, era: Era = 'ALONZO') {
    const tx = deserializeTx(cborTx);
    const txAuxData = tx.auxiliary_data()
      ?? csl.AuxiliaryData.new();

    txAuxData.set_metadata(
      csl.GeneralTransactionMetadata.from_hex(cborTxMetadata),
    );

    txAuxData.set_prefer_alonzo_format(
      era === 'ALONZO',
    );

    return csl.Transaction.new(
      tx.body(), tx.witness_set(), txAuxData,
    ).to_hex();
  }

  get size(): number {
    return this._txBuilder.full_size();
  }

  async build(): Promise<string> {
    try {
      if (
        this._mintBuilder.has_plutus_scripts() ||
        this.notVisited('redeemValue') === false
      ) {
        await this.addRequiredSignersIfNeeded();
        await this.addCollateralIfNeeded();
      }

      await this.forgeAssetsIfNeeded();
      await this.addTxInputsAsNeeded();
      await this.addChangeAddress();

      return this._txBuilder.build_tx().to_hex();
    } catch (error) {
      throw new Error(`[Transaction] An error occurred during build: ${error}.`);
    }
  }

  burnAsset(
    forgeScript: string | PlutusScript | UTxO,
    asset: Asset, redeemer?: Partial<Action>,
  ): Transaction {
    const totalQuantity = this._totalBurns.has(asset.unit)
      ? csl.BigNum.from_str(this._totalBurns.get(asset.unit) ?? '0')
          .checked_add(csl.BigNum.from_str(asset.quantity)).to_str()
      : asset.quantity;

    this._mintBuilder.add_asset(
      buildMintWitness(forgeScript, redeemer),
      csl.AssetName.new(toBytes(asset.unit.slice(POLICY_ID_LENGTH))),
      csl.Int.new_negative(csl.BigNum.from_str(asset.quantity)),
    );

    this._totalBurns.set(asset.unit, totalQuantity);

    return this;
  }

  delegateStake(rewardAddress: string, poolId: string): Transaction {
    const stakeDelegation = csl.Certificate.new_stake_delegation(
      csl.StakeDelegation.new(
        csl.StakeCredential.from_keyhash(
          deserializeEd25519KeyHash(resolveStakeKeyHash(rewardAddress)),
        ),
        csl.Ed25519KeyHash.from_bech32(poolId),
      ),
    );

    this._txCertificates.add(stakeDelegation);

    return this;
  }

  deregisterStake(rewardAddress: string): Transaction {
    const stakeDeregistration = csl.Certificate.new_stake_deregistration(
      csl.StakeDeregistration.new(
        csl.StakeCredential.from_keyhash(
          deserializeEd25519KeyHash(resolveStakeKeyHash(rewardAddress)),
        ),
      ),
    );

    this._txCertificates.add(stakeDeregistration);

    return this;
  }

  @Checkpoint()
  mintAsset(
    forgeScript: string | PlutusScript | UTxO,
    mint: Mint, redeemer?: Partial<Action>,
  ): Transaction {
    const toAsset = (
      forgeScript: string | PlutusScript | UTxO, mint: Mint,
    ): Asset => {
      const policyId = typeof forgeScript === 'string'
        ? deserializeNativeScript(forgeScript).hash().to_hex()
        : toPlutusScript(forgeScript).hash().to_hex();

      const assetName = fromUTF8(mint.assetName);

      return {
        unit: `${policyId}${assetName}`,
        quantity: mint.assetQuantity,
      };
    };

    const toPlutusScript = (script: PlutusScript | UTxO) => {
      if ('code' in script) {
        return deserializePlutusScript(script.code, script.version);
      }

      const utxo = toTxUnspentOutput(script);
      if (utxo.output().has_script_ref()) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const scriptRef = utxo.output().script_ref()!;
        if (scriptRef.is_plutus_script()) {
          const plutusScript = fromScriptRef(scriptRef) as PlutusScript;
          return deserializePlutusScript(
            plutusScript.code, plutusScript.version,
          );
        }
      }

      throw new Error(
        `No plutus script reference found in UTxO: ${utxo.input().transaction_id().to_hex()}`,
      );
    };

    const asset = toAsset(forgeScript, mint);

    const existingQuantity = csl.BigNum
      .from_str(this._totalMints.get(asset.unit)?.assetQuantity ?? '0');

    const totalQuantity = existingQuantity
      .checked_add(csl.BigNum.from_str(asset.quantity));

    this._mintBuilder.add_asset(
      buildMintWitness(forgeScript, redeemer),
      csl.AssetName.new(toBytes(fromUTF8(mint.assetName))),
      csl.Int.new(csl.BigNum.from_str(asset.quantity)),
    );

    if (this._recipients.has(mint.recipient))
      this._recipients.get(mint.recipient)?.push(asset);
    else this._recipients.set(mint.recipient, [asset]);

    this._totalMints.set(asset.unit, {
      ...mint, assetQuantity: totalQuantity.to_str(),
    });

    return this;
  }

  @Checkpoint()
  redeemValue(options: {
    value: UTxO, script: PlutusScript | UTxO,
    datum: Data | UTxO, redeemer?: Action,
  }): Transaction {
    const redeemer: Action = {
      tag: 'SPEND',
      budget: DEFAULT_REDEEMER_BUDGET,
      index: this._txInputsBuilder.inputs().len(),
      data: {
        alternative: 0,
        fields: [],
      },
      ...options.redeemer,
    };

    const utxo = toTxUnspentOutput(options.value);
    const witness = csl.PlutusWitness.new_with_ref(
      buildPlutusScriptSource(options.script),
      buildDatumSource(options.datum),
      toRedeemer(redeemer),
    );

    this._txInputsBuilder.add_plutus_script_input(
      witness, utxo.input(), utxo.output().amount(),
    );

    return this;
  }

  registerStake(rewardAddress: string): Transaction {
    const stakeRegistration = csl.Certificate.new_stake_registration(
      csl.StakeRegistration.new(
        csl.StakeCredential.from_keyhash(
          deserializeEd25519KeyHash(resolveStakeKeyHash(rewardAddress)),
        ),
      ),
    );

    this._txCertificates.add(stakeRegistration);

    return this;
  }

  registerPool(params: PoolParams): Transaction {
    const poolRegistration = csl.Certificate.new_pool_registration(
      csl.PoolRegistration.new(toPoolParams(params)),
    );

    this._txCertificates.add(poolRegistration);

    return this;
  }

  retirePool(poolId: string, epochNo: number): Transaction {
    const poolRetirement = csl.Certificate.new_pool_retirement(
      csl.PoolRetirement.new(csl.Ed25519KeyHash.from_bech32(poolId), epochNo),
    );

    this._txCertificates.add(poolRetirement);

    return this;
  }

  @Checkpoint()
  sendAssets(
    recipient: Recipient, assets: Asset[], lovelace?: string
  ): Transaction {
    const amount = toValue(assets);
    const multiAsset = amount.multiasset();

    if (amount.is_zero() || multiAsset === undefined)
      return this;

    const txOutputBuilder = buildTxOutputBuilder(
      recipient,
    );

    const tx = txOutputBuilder.next();

    if (lovelace) {
      tx.with_coin_and_asset(csl.BigNum.from_str(lovelace), multiAsset);
    } else {
      tx.with_asset_and_min_required_coin_by_utxo_cost(multiAsset,
        buildDataCost(this._protocolParameters.coinsPerUTxOSize),
      );
    }
      
    const txOutput =  tx.build();

    this._txBuilder.add_output(txOutput);

    return this;
  }

  sendLovelace(
    recipient: Recipient, lovelace: string,
  ): Transaction {
    const txOutputBuilder = buildTxOutputBuilder(
      recipient,
    );

    const txOutput = txOutputBuilder.next()
      .with_coin(csl.BigNum.from_str(lovelace))
      .build();

    this._txBuilder.add_output(txOutput);

    return this;
  }

  @Checkpoint()
  sendValue(
    recipient: Recipient, value: UTxO,
  ): Transaction {
    const amount = toValue(value.output.amount);
    const txOutputBuilder = buildTxOutputBuilder(
      recipient,
    );

    const txOutput = txOutputBuilder.next()
      .with_value(amount)
      .build();

    this._txBuilder.add_output(txOutput);

    return this;
  }

  setChangeAddress(changeAddress: string): Transaction {
    this._changeAddress = toAddress(changeAddress);

    return this;
  }

  @Checkpoint()
  setCollateral(collateral: UTxO[]): Transaction {
    const txInputsBuilder = buildTxInputsBuilder(collateral);

    this._txBuilder.set_collateral(txInputsBuilder);

    return this;
  }

  setMetadata(key: number, value: unknown): Transaction {
    this._txBuilder.add_json_metadatum_with_schema(
      csl.BigNum.from_str(key.toString()), JSON.stringify(value),
      csl.MetadataJsonSchema.NoConversions,
    );

    return this;
  }

  @Checkpoint()
  setRequiredSigners(addresses: string[]): Transaction {
    const signatures = Array.from(new Set(
      addresses
        .map((address) => {
          return address.startsWith('addr')
            ? resolvePaymentKeyHash(address)
            : resolveStakeKeyHash(address);
        })
        .map((keyHash) => deserializeEd25519KeyHash(keyHash))
    ));

    signatures.forEach((signature) => {
      this._txBuilder.add_required_signer(signature);
    });

    return this;
  }

  setTimeToStart(slot: string): Transaction {
    this._txBuilder.set_validity_start_interval_bignum(
      csl.BigNum.from_str(slot),
    );

    return this;
  }

  setTimeToExpire(slot: string): Transaction {
    this._txBuilder.set_ttl_bignum(
      csl.BigNum.from_str(slot),
    );

    return this;
  }

  @Checkpoint()
  setTxInputs(inputs: UTxO[]): Transaction {
    inputs
      .map((input) => toTxUnspentOutput(input))
      .forEach((utxo) => {
        this._txInputsBuilder.add_input(
          utxo.output().address(),
          utxo.input(),
          utxo.output().amount(),
        );
      });

    return this;
  }

  withdrawRewards(rewardAddress: string, lovelace: string): Transaction {
    const address = toRewardAddress(rewardAddress);

    if (address !== undefined) {
      this._txWithdrawals.insert(
        address, csl.BigNum.from_str(lovelace),
      );
    }

    return this;
  }

  private async addBurnInputsIfNeeded() {
    if (
      this._initiator
      && this._totalBurns.size > 0
      && this.notVisited('setTxInputs')
    ) {
      const utxos = await this._initiator.getUsedUTxOs();
      const inputs = largestFirstMultiAsset(this._totalBurns,
        utxos.map((utxo) => fromTxUnspentOutput(utxo)),
      ).map((utxo) => toTxUnspentOutput(utxo));

      inputs
        .forEach((utxo) => {
          this._txInputsBuilder.add_input(
            utxo.output().address(),
            utxo.input(),
            utxo.output().amount(),
          );
        });
    }
  }

  private async addChangeAddress() {
    if (this._initiator && this._changeAddress === undefined) {
      const address = await this._initiator.getUsedAddress();
      this._txBuilder.add_change_if_needed(address);
    } else if (this._changeAddress !== undefined) {
      this._txBuilder.add_change_if_needed(this._changeAddress);
    }
  }

  private async addCollateralIfNeeded() {
    if (this._initiator && this.notVisited('setCollateral')) {
      const collateral = await this._initiator.getUsedCollateral();
      this._txBuilder.set_collateral(buildTxInputsBuilder(collateral));
    }
  }

  private async addRequiredSignersIfNeeded() {
    if (this._initiator && this.notVisited('setRequiredSigners')) {
      const address = await this._initiator.getUsedAddress();
      const keyHash = resolvePaymentKeyHash(address.to_bech32());
      this._txBuilder.add_required_signer(deserializeEd25519KeyHash(keyHash));
    }
  }

  private async addTxInputsAsNeeded() {
    this._txBuilder.set_inputs(this._txInputsBuilder);

    if (
      this._mintBuilder.has_native_scripts() ||
      this._mintBuilder.has_plutus_scripts()
    ) {
      this._txBuilder.set_mint_builder(this._mintBuilder);
    }

    if (this._txCertificates.len() > 0) {
      this._txBuilder.set_certs(this._txCertificates);
    }

    if (this._txWithdrawals.len() > 0) {
      this._txBuilder.set_withdrawals(this._txWithdrawals);
    }

    if (this.notVisited('setTxInputs')) {
      const hasMultiAsset = !this.notVisited('mintAsset')
        || !this.notVisited('sendAssets')
        || !this.notVisited('sendValue');

      // insure change holds enough ADA to cover multiasset.
      const selectedUTxOs = await this.selectLovelaceUTxOs(false);
      const availableUTxOs = await this.filterAvailableUTxOs(selectedUTxOs);
      
      const coinSelectionStrategy = hasMultiAsset
        ? csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset
        : csl.CoinSelectionStrategyCIP2.LargestFirst;

      this._txBuilder.add_inputs_from(availableUTxOs, coinSelectionStrategy);
    }

    if (
      this._txBuilder.get_mint_builder() ||
      this.notVisited('redeemValue') === false
    ) {
      const costModels = this._era !== undefined
        ? SUPPORTED_COST_MODELS[this._era]
        : SUPPORTED_COST_MODELS.BABBAGE;

      this._txBuilder.calc_script_data_hash(costModels);
    }
  }

  private async forgeAssetsIfNeeded() {
    type Mintdata = { unit: string, data: Mint };
    type Metadata = Record<string, Record<string, AssetMetadata>>;

    const forge = (mint: Mintdata, meta?: Metadata): Metadata => {
      const name = mint.data.assetName;
      const metadata = mint.data.metadata;
      const collection = mint.unit
        .slice(0, POLICY_ID_LENGTH);

      if (meta && meta[collection]) {
        const {
          [collection]: oldCollection, ...rest
        } = meta;

        const newCollection = {
          [name]: metadata,
          ...oldCollection,
        };

        return {
          [collection]: {
            ...newCollection,
          }, ...rest,
        };
      }

      if (meta !== undefined) {
        return {
          [collection]: {
            [name]: metadata,
          },
          ...meta,
        };
      }

      return {
        [collection]: { [name]: metadata },
      };
    };

    await this.addBurnInputsIfNeeded();

    Array
      .from(this._totalMints, (mint) => (<Mintdata>{
        unit: mint[0],
        data: mint[1],
      }))
      .reduce((metadatums, mint) => {
        return metadatums.set(mint.data.label, forge(
          mint, metadatums.get(mint.data.label),
        ));
      }, new Map<string, Metadata>)
      .forEach((metadata, label) => {
        this._txBuilder.add_json_metadatum(
          csl.BigNum.from_str(label),
          JSON.stringify(metadata),
        );
      });

    this.addMintOutputs();
  }

  private async filterAvailableUTxOs(selectedUTxOs: UTxO[] = []) {
    const txUnspentOutputs = csl.TransactionUnspentOutputs.new();

    if (this._initiator === undefined)
      return txUnspentOutputs;

    const allUTxOs = await this._initiator
      .getUsedUTxOs();

    allUTxOs
      .filter((au) => {
        return (
          selectedUTxOs.find(
            (su) => su.input.txHash === au.input().transaction_id().to_hex()
          ) === undefined
        );
      })
      .forEach((utxo) => {
        txUnspentOutputs.add(utxo);
      });

    return txUnspentOutputs;
  }

  private async selectLovelaceUTxOs(hasMultiAsset: boolean) {
    if (this._initiator === undefined || hasMultiAsset === false)
      return [];

    const utxos = await this._initiator.getUsedUTxOs();

    const selection = largestFirst('5000000',
      utxos.map((utxo) => fromTxUnspentOutput(utxo)),
    );

    const inputs = selection
      .map((utxo) => toTxUnspentOutput(utxo));

    inputs
      .forEach((utxo) => {
        this._txBuilder.add_input(
          utxo.output().address(),
          utxo.input(),
          utxo.output().amount(),
        );
      });

    return selection;
  }

  private addMintOutputs() {
    this._recipients.forEach((assets, recipient) => {
      const amount = toValue(assets);
      const multiAsset = amount.multiasset();

      if (multiAsset !== undefined) {
        const txOutputBuilder = buildTxOutputBuilder(
          recipient,
        );

        const txOutput = txOutputBuilder.next()
          .with_asset_and_min_required_coin_by_utxo_cost(multiAsset,
            buildDataCost(this._protocolParameters.coinsPerUTxOSize),
          ).build();

        this._txBuilder.add_output(txOutput);
      }
    });
  }

  private notVisited(checkpoint: string) {
    return (
      (this as unknown as TrackableObject).__visits
        .includes(checkpoint) === false
    );
  }
}

type CreateTxOptions = {
  initiator: IInitiator;
  parameters: Protocol;
  era: Era;
};
