import { BrowserWindow } from 'electron';
import { debounce } from 'throttle-debounce';
import { SingleSigTemplate, TemplateRegistry } from '@spacemesh/sm-codec';
import Bech32 from '@spacemesh/address-wasm';
import { sha256 } from '@spacemesh/sm-codec/lib/utils/crypto';
import {
  AccountWithBalance,
  asTx,
  Bech32Address,
  HexString,
  KeyPair,
  Reward,
  toTxState,
  Tx,
  TxSendRequest,
  TxState,
} from '../shared/types';
import { ipcConsts } from '../app/vars';
import { AccountDataFlag } from '../proto/spacemesh/v1/AccountDataFlag';
import { Transaction__Output } from '../proto/spacemesh/v1/Transaction';
import { TransactionState__Output } from '../proto/spacemesh/v1/TransactionState';
import { AccountData__Output } from '../proto/spacemesh/v1/AccountData';
import { MeshTransaction__Output } from '../proto/spacemesh/v1/MeshTransaction';
import { Reward__Output } from '../proto/spacemesh/v1/Reward';
import { Account__Output } from '../proto/spacemesh/v1/Account';
import { hasRequiredRewardFields } from '../shared/types/guards';
import {
  delay,
  fromHexString,
  longToNumber,
  toHexString,
} from '../shared/utils';
import { MAX_GAS } from '../shared/constants';
import { getMethodName, getTemplateName } from '../shared/templateMeta';
import { addReceiptToTx, toTx } from './transformers';
import TransactionService from './TransactionService';
import MeshService from './MeshService';
import GlobalStateService, {
  AccountDataStreamHandlerArg,
  AccountDataValidFlags,
} from './GlobalStateService';
import { AccountStateManager } from './AccountState';
import Logger from './logger';
import { GRPC_QUERY_BATCH_SIZE } from './main/constants';
import { sign } from './ed25519';

type TxHandlerArg = MeshTransaction__Output | null | undefined;
type TxHandler = (tx: TxHandlerArg) => void;

type RewardHandlerArg = Reward__Output | null | undefined;

class TransactionManager {
  logger = Logger({ className: 'TransactionManager' });

  private readonly meshService: MeshService;

  private readonly glStateService: GlobalStateService;

  private readonly txService: TransactionService;

  keychain: KeyPair[] = [];

  accounts: AccountWithBalance[] = [];

  private readonly mainWindow: BrowserWindow;

  private txStateStream: Record<
    string,
    ReturnType<TransactionService['activateTxStream']>
  > = {};

  private accountStates: Record<string, AccountStateManager> = {};

  private unsubs: Record<Bech32Address, (() => void)[]> = {};

  private genesisID: string;

  constructor(
    meshService: MeshService,
    glStateService: GlobalStateService,
    txService: TransactionService,
    mainWindow: BrowserWindow,
    genesisID: string
  ) {
    this.meshService = meshService;
    this.glStateService = glStateService;
    this.txService = txService;
    this.mainWindow = mainWindow;
    this.genesisID = genesisID;
  }

  unsubscribeAllStreams = () => {
    Object.values(this.unsubs).forEach((list) =>
      list.forEach((unsub) => unsub())
    );
    this.unsubs = {};
  };

  //
  appStateUpdater = (channel: ipcConsts, payload: any) => {
    this.mainWindow.webContents.send(channel, { ...payload });
  };

  // Debounce update functions to avoid excessive IPC calls
  updateAppStateAccount = (address: string) => {
    const account = this.accountStates[address].getState();
    if (!account) {
      return;
    }
    this.appStateUpdater(ipcConsts.T_M_UPDATE_ACCOUNT, {
      account,
      accountId: address,
    });
  };

  updateAppStateTxs = (publicKey: string) => {
    const txs = this.accountStates[publicKey].getTxs() || {};
    this.appStateUpdater(ipcConsts.T_M_UPDATE_TXS, { txs, publicKey });
  };

  updateAppStateRewards = (publicKey: string) => {
    const rewards = this.accountStates[publicKey].getRewards() || [];
    this.appStateUpdater(ipcConsts.T_M_UPDATE_REWARDS, { rewards, publicKey });
  };

  private storeTx = (publicKey: string, tx: Tx): Promise<void> =>
    this.accountStates[publicKey]
      .storeTransaction(tx)
      .then(() => this.updateAppStateTxs(publicKey))
      .catch((err) => {
        console.log('TransactionManager.storeTx', err); // eslint-disable-line no-console
        this.logger.error('TransactionManager.storeTx', err);
      });

  private storeReward = (publicKey: string, reward: Reward) =>
    this.accountStates[publicKey]
      .storeReward(reward)
      .then(() => this.updateAppStateRewards(publicKey))
      .catch((err) => {
        console.log('TransactionManager.storeReward', err); // eslint-disable-line no-console
        this.logger.error('TransactionManager.storeReward', err);
      });

  private handleNewTx = (publicKey: string) => async (tx: {
    transaction: Transaction__Output | null;
    transactionState: TransactionState__Output | null;
  }) => {
    if (!tx.transaction || !tx.transactionState || !tx.transactionState.state)
      return;
    const newTx = toTx(tx.transaction, toTxState(tx.transactionState.state));
    if (!newTx) return;
    await this.upsertTransaction(publicKey)(newTx);
  };

  private subscribeTransactions = debounce(100, (publicKey: string) => {
    const txs = this.accountStates[publicKey].getTxs();
    const txIds = Object.keys(txs).map(fromHexString);

    const unsubTxStateStream = this.txStateStream[publicKey];
    // Unsubscribe
    unsubTxStateStream && unsubTxStateStream();

    this.txStateStream[publicKey] = this.txService.activateTxStream(
      this.handleNewTx(publicKey),
      txIds
    );
  });

  private subscribeAccount = (address: Bech32Address): void => {
    // Cancel account Txs subscription
    this.txStateStream[address]?.();

    const lastTxLayer = this.accountStates[address]?.lastSyncedTxLayer();
    const lastRwLayer = this.accountStates[address]?.lastSyncedRewardsLayer();
    const addTransaction = this.upsertTransactionFromMesh(address);
    this.retrieveHistoricTxData({
      accountId: address,
      offset: lastTxLayer,
      handler: addTransaction,
      retries: 0,
    });
    this.unsubs[address].push(
      this.meshService.listenMeshTransactions(address, addTransaction)
    );

    const updateAccountData = this.updateAccountData(address);
    this.retrieveAccountData({
      filter: {
        accountId: { address },
        accountDataFlags: AccountDataFlag.ACCOUNT_DATA_FLAG_ACCOUNT,
      },
      handler: updateAccountData,
      retries: 0,
    });

    this.unsubs[address].push(
      this.glStateService.activateAccountDataStream(
        address,
        AccountDataFlag.ACCOUNT_DATA_FLAG_ACCOUNT,
        updateAccountData
      )
    );

    this.unsubs[address].push(
      this.txService.watchTransactionsByAddress(address, (txRes) => {
        if (!txRes.tx) return;
        const state = toTxState(TxState.PROCESSED, txRes.status || 0);
        const tx = toTx(txRes.tx, state);
        if (!tx) return;
        this.upsertTransaction(address)({
          ...tx,
          layer: txRes.layer,
        });
      })
    );

    const txs = Object.keys(this.accountStates[address].getTxs() || {});
    if (txs.length > 0) {
      this.subscribeTransactions(address);
    }

    const addReward = this.addReward(address);
    this.retrieveRewards(address, lastRwLayer)
      .then((value) => value.forEach(addReward))
      .catch((err) => {
        this.logger.error('Can not retrieve and store rewards', err);
      });

    this.unsubs[address].push(
      this.glStateService.listenRewardsByCoinbase(address, addReward)
    );
  };

  addAccount = (keypair: KeyPair) => {
    const { publicKey } = keypair;
    const pkBytes = fromHexString(publicKey);
    const tpl = TemplateRegistry.get(SingleSigTemplate.key, 0);
    const principal = tpl.principal({ PublicKey: pkBytes });
    const address = Bech32.generateAddress(principal);

    const idx = this.keychain.findIndex((kp) => kp.publicKey === publicKey);
    this.keychain = [
      ...(idx > -1
        ? this.keychain
            .slice(0, Math.max(0, idx - 1))
            .concat(this.keychain.slice(idx + 1))
        : this.keychain),
      keypair,
    ];
    this.accountStates[address] = new AccountStateManager(
      address,
      this.genesisID
    );
    // Send stored Tx & Rewards
    this.updateAppStateTxs(address);
    this.updateAppStateRewards(address);

    this.unsubs[address] = [];
    // Resubscribe
    this.subscribeAccount(address);
  };

  setAccounts = (accounts: KeyPair[]) => {
    this.unsubscribeAllStreams();
    this.keychain = [];
    this.accountStates = {};
    accounts.forEach(this.addAccount);
  };

  private upsertTransaction = (accountAddress: Bech32Address) => async <T>(
    tx: Tx<T>
  ) => {
    if (!this.accountStates[accountAddress]) return;
    const originalTx = this.accountStates[accountAddress].getTxById(tx.id);
    const receipt = tx.receipt
      ? { ...originalTx?.receipt, ...tx.receipt }
      : originalTx?.receipt;
    // Do not downgrade status from SUCCESS/FAILURE/INVALID
    let { status } = tx;
    if (
      originalTx?.status > TxState.PROCESSED &&
      originalTx?.status > tx.status
    ) {
      status = originalTx.status;
    }
    const updatedTx: Tx = { ...originalTx, ...tx, status, receipt };
    await this.storeTx(accountAddress, updatedTx);
    this.subscribeTransactions(accountAddress);
  };

  private upsertTransactionFromMesh = (accountAddress: Bech32Address) => async (
    tx: TxHandlerArg
  ) => {
    if (!tx || !tx?.transaction?.id || !tx.layerId) return;
    const newTxData = toTx(tx.transaction, null);
    if (!newTxData) return;
    this.upsertTransaction(accountAddress)({
      ...newTxData,
      ...(tx.layerId?.number ? { layer: tx.layerId.number } : {}),
    });
  };

  retrieveHistoricTxData = async ({
    accountId,
    offset,
    handler,
    retries,
  }: {
    accountId: string;
    offset: number;
    handler: TxHandler;
    retries: number;
  }) => {
    const {
      data,
      totalResults,
      error,
    } = await this.meshService.requestMeshTransactions(accountId, offset);
    if (error && retries < 5) {
      await this.retrieveHistoricTxData({
        accountId,
        offset,
        handler,
        retries: retries + 1,
      });
    } else {
      data && data.length && data.forEach((tx) => handler(tx.meshTransaction));
      if (offset + GRPC_QUERY_BATCH_SIZE < totalResults) {
        await this.retrieveHistoricTxData({
          accountId,
          offset: offset + GRPC_QUERY_BATCH_SIZE,
          handler,
          retries: 0,
        });
      }
    }
  };

  updateAccountData = (address: string) => (data: Account__Output) => {
    if (!this.accountStates[address]) return;
    const currentState = {
      counter: longToNumber(data.stateCurrent?.counter || 0),
      balance: longToNumber(data.stateCurrent?.balance?.value || 0),
    };
    const projectedState = {
      counter: longToNumber(data.stateProjected?.counter || 0),
      balance: longToNumber(data.stateProjected?.balance?.value || 0),
    };
    this.accountStates[address] &&
      this.accountStates[address].storeState({
        currentState,
        projectedState,
      });

    this.updateAppStateAccount(address);
  };

  retrieveAccountData = async <F extends AccountDataValidFlags>({
    filter,
    handler,
    retries,
  }: {
    filter: {
      accountId: { address: string };
      accountDataFlags: F;
    };
    handler: (data: AccountDataStreamHandlerArg[F]) => void;
    retries: number;
  }) => {
    const { data, error } = await this.glStateService.sendAccountDataQuery({
      filter,
      offset: 0,
    });
    if (error && retries < 5) {
      await this.retrieveAccountData({
        filter,
        handler,
        retries: retries + 1,
      });
    } else {
      data?.length > 0 && handler(data[0]);
    }
  };

  addReward = (accountId: HexString) => (reward: RewardHandlerArg) => {
    if (!reward || !hasRequiredRewardFields(reward)) return;
    const parsedReward: Reward = {
      layer: reward.layer.number,
      amount: longToNumber(reward.total.value),
      layerReward: longToNumber(reward.layerReward.value),
      coinbase: reward.coinbase.address,
    };
    this.storeReward(accountId, parsedReward);
  };

  retrieveRewards = async (
    coinbase: string,
    offset = 0
  ): Promise<Reward__Output[]> => {
    const composeArg = (batchNumber: number) => ({
      filter: {
        accountId: { address: coinbase },
        accountDataFlags: AccountDataFlag.ACCOUNT_DATA_FLAG_REWARD as AccountDataValidFlags,
      },
      offset: offset + batchNumber * GRPC_QUERY_BATCH_SIZE,
    });
    const getAccountDataQuery = async (batch: number, retries = 5) => {
      const res = await this.glStateService.sendAccountDataQuery(
        composeArg(batch)
      );
      if (res.error && retries > 0) {
        this.logger.debug(
          `retrieveRewards (retry ${retries})`,
          res,
          composeArg(batch)
        );
        await delay(1000);
        return getAccountDataQuery(batch, retries - 1);
      }
      return res;
    };
    const { totalResults, data } = await getAccountDataQuery(0);
    if (totalResults <= GRPC_QUERY_BATCH_SIZE) {
      return data.filter(
        (item): item is Reward__Output =>
          !!item && hasRequiredRewardFields(item)
      ) as Reward__Output[];
    } else {
      const nextRewards = await this.retrieveRewards(
        coinbase,
        offset + GRPC_QUERY_BATCH_SIZE
      );
      return data ? [...data, ...nextRewards] : nextRewards;
    }
  };

  retrieveNewRewards = async (coinbase: string) => {
    const oldRewards = this.accountStates[coinbase]?.getRewards() || [];
    const newRewards = (
      await this.retrieveRewards(
        coinbase,
        this.accountStates[coinbase]?.lastSyncedRewardsLayer() || 0
      )
    ).reduce((acc, reward) => {
      if (!reward || !hasRequiredRewardFields(reward)) return acc;
      const parsedReward: Reward = {
        layer: reward.layer.number,
        amount: longToNumber(reward.total.value),
        layerReward: longToNumber(reward.layerReward.value),
        coinbase: reward.coinbase.address,
      };
      return [...acc, parsedReward];
    }, <Reward[]>[]);
    return [...oldRewards, ...newRewards];
  };

  // TODO: Replace with generic `publishTx`
  publishSelfSpawn = async (fee: number, accountIndex: number) => {
    try {
      const { publicKey, secretKey } = this.keychain[accountIndex];
      const tpl = TemplateRegistry.get(SingleSigTemplate.key, 0);
      const spawnArgs = { PublicKey: fromHexString(publicKey) };
      const principal = tpl.principal(spawnArgs);
      const address = Bech32.generateAddress(principal);
      const { projectedState } = this.accountStates[address].getState();
      const payload = {
        Nonce: {
          Counter: BigInt(projectedState?.counter || 0),
          Bitfield: BigInt(0),
        },
        GasPrice: BigInt(fee),
        Arguments: spawnArgs,
      };
      const txEncoded = tpl.encode(principal, payload);
      const genesisID = await this.meshService.getGenesisID();
      const hashed = sha256(new Uint8Array([...genesisID, ...txEncoded]));
      const sig = sign(hashed, secretKey);
      const signed = tpl.sign(txEncoded, sig);
      const response = await this.txService.submitTransaction({
        transaction: signed,
      });
      const getTxResponseError = () =>
        new Error('Can not retrieve a transaction data');

      // TODO: Refactor to avoid mixing data with errors and then get rid of insane ternaries for each data piece
      const error =
        response.error || response.txstate === null || !response.txstate.id?.id
          ? response.error || getTxResponseError()
          : null;
      const { currentLayer } = await this.meshService.getCurrentLayer();
      // Compose "initial" transaction record
      const method = 0;
      const tx =
        response.error === null && response.txstate?.id?.id
          ? asTx({
              id: toHexString(response.txstate.id.id),
              template: Bech32.generateAddress(SingleSigTemplate.publicKey),
              method,
              principal: address,
              gas: {
                gasPrice: fee,
                maxGas: MAX_GAS,
                fee: fee * MAX_GAS,
              },
              status: toTxState(response.txstate.state),
              payload,
              meta: {
                templateName: getTemplateName(SingleSigTemplate.publicKey),
                methodName: getMethodName(SingleSigTemplate.publicKey, method),
              },
              layer: currentLayer,
            })
          : null;
      tx && this.upsertTransaction(address)(tx);

      // TODO: Get rid of this call when we migrate to go-spacemesh
      //       with this fix of the issue https://github.com/spacemeshos/go-spacemesh/issues/3687
      this.retrieveAccountData({
        filter: {
          accountId: { address },
          accountDataFlags: AccountDataFlag.ACCOUNT_DATA_FLAG_ACCOUNT,
        },
        handler: this.updateAccountData(address),
        retries: 0,
      });

      return { error, tx };
    } catch (err) {
      this.logger.error('publishSelfSpawn', err);
      return {
        error: err,
        tx: null,
      };
    }
  };

  publishSpendTx = async ({
    fullTx,
    accountIndex,
  }: {
    fullTx: TxSendRequest;
    accountIndex: number;
  }) => {
    try {
      const { publicKey, secretKey } = this.keychain[accountIndex];
      const tpl = TemplateRegistry.get(SingleSigTemplate.key, 1);
      const principal = tpl.principal({
        PublicKey: fromHexString(publicKey),
      });
      const address = Bech32.generateAddress(principal);
      const { projectedState } = this.accountStates[address].getState();
      const { receiver, amount, fee } = fullTx;
      const payload = {
        Arguments: {
          Destination: Bech32.parse(receiver),
          Amount: BigInt(amount),
        },
        Nonce: {
          Counter: BigInt(projectedState?.counter || 1),
          Bitfield: BigInt(0),
        },
        GasPrice: BigInt(fee),
      };
      const txEncoded = tpl.encode(principal, payload);
      const genesisID = await this.meshService.getGenesisID();
      const hashed = sha256(new Uint8Array([...genesisID, ...txEncoded]));
      const sig = sign(hashed, secretKey);
      const signed = tpl.sign(txEncoded, sig);
      const response = await this.txService.submitTransaction({
        transaction: signed,
      });
      const getTxResponseError = () =>
        new Error('Can not retrieve a transaction data');

      // TODO: Refactor to avoid mixing data with errors and then get rid of insane ternaries for each data piece
      const error =
        response.error || response.txstate === null || !response.txstate.id?.id
          ? response.error || getTxResponseError()
          : null;
      // Compose "initial" transaction record
      const { currentLayer } = await this.meshService.getCurrentLayer();
      const method = 1;
      const tx =
        response.error === null && response.txstate?.id?.id
          ? asTx({
              id: toHexString(response.txstate.id.id),
              template: Bech32.generateAddress(SingleSigTemplate.publicKey),
              method,
              principal: address,
              gas: {
                gasPrice: fee,
                maxGas: MAX_GAS,
                fee: fee * MAX_GAS,
              },
              status: toTxState(response.txstate.state),
              payload: {
                ...payload,
                Arguments: {
                  ...payload.Arguments,
                  Destination: Bech32.generateAddress(
                    payload.Arguments.Destination
                  ),
                },
              },
              meta: {
                templateName: getTemplateName(SingleSigTemplate.publicKey),
                methodName: getMethodName(SingleSigTemplate.publicKey, method),
              },
              layer: currentLayer,
              ...((fullTx.note && { note: fullTx.note }) || {}),
            })
          : null;

      tx && this.upsertTransaction(address)(tx);

      // TODO: Get rid of this call when we migrate to go-spacemesh
      //       with this fix of the issue https://github.com/spacemeshos/go-spacemesh/issues/3687
      this.retrieveAccountData({
        filter: {
          accountId: { address },
          accountDataFlags: AccountDataFlag.ACCOUNT_DATA_FLAG_ACCOUNT,
        },
        handler: this.updateAccountData(address),
        retries: 0,
      });

      return { error, tx };
    } catch (err) {
      this.logger.error('publishSpendTx', err);
      return {
        error: err,
        tx: null,
      };
    }
  };

  updateTxNote = ({
    address,
    txId,
    note,
  }: {
    address: Bech32Address;
    txId: HexString;
    note: string;
  }) => {
    const tx = this.accountStates[address].getTxById(txId);
    return this.upsertTransaction(address)({ ...tx, note });
  };
}

export default TransactionManager;
