import { Signature } from '@ethersproject/bytes';
import { ContractReceipt } from '@ethersproject/contracts';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { METRIC_PAUSE_ATTEMPTS } from 'common/prometheus';
import { OneAtTime } from 'common/decorators';
import { SecurityAbi } from 'generated';
import { RepositoryService } from 'contracts/repository';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Counter } from 'prom-client';
import { BlockTag, ProviderService } from 'provider';
import { WalletService } from 'wallet';

@Injectable()
export class SecurityService {
  constructor(
    @InjectMetric(METRIC_PAUSE_ATTEMPTS) private pauseAttempts: Counter<string>,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: LoggerService,
    private providerService: ProviderService,
    private repositoryService: RepositoryService,
    private walletService: WalletService,
  ) {}

  private cachedAttestMessagePrefix: string | null = null;
  private cachedPauseMessagePrefix: string | null = null;

  public async initialize(blockTag: BlockTag): Promise<void> {
    const guardianIndex = await this.getGuardianIndex(blockTag);
    const address = this.walletService.address;

    if (guardianIndex === -1) {
      this.logger.warn(`Your address is not in the Guardian List`, { address });
    } else {
      this.logger.log(`Your address is in the Guardian List`, { address });
    }
  }

  /**
   * Returns an instance of the contract that can send signed transactions
   */
  public async getContractWithSigner(): Promise<SecurityAbi> {
    const wallet = this.walletService.wallet;
    const provider = this.providerService.provider;
    const walletWithProvider = wallet.connect(provider);
    const contract = await this.repositoryService.getCachedDSMContract();
    const contractWithSigner = contract.connect(walletWithProvider);

    return contractWithSigner;
  }
  /**
   * Returns a prefix from the contract with which the deposit message should be signed
   */
  public async getAttestMessagePrefix(): Promise<string> {
    if (!this.cachedAttestMessagePrefix) {
      const contract = await this.repositoryService.getCachedDSMContract();
      const messagePrefix = await contract.ATTEST_MESSAGE_PREFIX();
      this.cachedAttestMessagePrefix = messagePrefix;
    }

    return this.cachedAttestMessagePrefix;
  }

  /**
   * Returns a prefix from the contract with which the pause message should be signed
   */
  public async getPauseMessagePrefix(): Promise<string> {
    if (!this.cachedPauseMessagePrefix) {
      const contract = await this.repositoryService.getCachedDSMContract();
      const messagePrefix = await contract.PAUSE_MESSAGE_PREFIX();
      this.cachedPauseMessagePrefix = messagePrefix;
    }

    return this.cachedPauseMessagePrefix;
  }

  /**
   * Returns the maximum number of deposits per transaction from the contract
   */
  public async getMaxDeposits(blockTag?: BlockTag): Promise<number> {
    const contract = await this.repositoryService.getCachedDSMContract();
    const maxDeposits = await contract.getMaxDeposits({
      blockTag: blockTag as any,
    });

    return maxDeposits.toNumber();
  }

  /**
   * Returns the guardian list from the contract
   */
  public async getGuardians(blockTag?: BlockTag): Promise<string[]> {
    const contract = await this.repositoryService.getCachedDSMContract();
    const guardians = await contract.getGuardians({
      blockTag: blockTag as any,
    });

    return guardians;
  }

  /**
   * Returns the guardian index in the list
   */
  public async getGuardianIndex(blockTag?: BlockTag): Promise<number> {
    const guardians = await this.getGuardians(blockTag);
    const address = this.walletService.address;

    return guardians.indexOf(address);
  }

  /**
   * Returns guardian address
   */
  public getGuardianAddress(): string {
    return this.walletService.address;
  }

  /**
   * Signs a message to deposit buffered ethers with the prefix from the contract
   */
  public async signDepositData(
    depositRoot: string,
    keysOpIndex: number,
    blockNumber: number,
    blockHash: string,
    stakingModuleId: number,
  ): Promise<Signature> {
    const prefix = await this.getAttestMessagePrefix();

    return await this.walletService.signDepositData({
      prefix,
      depositRoot,
      keysOpIndex,
      blockNumber,
      blockHash,
      stakingModuleId,
    });
  }

  /**
   * Signs a message to pause deposits with the prefix from the contract
   */
  public async signPauseData(
    blockNumber: number,
    stakingModuleId: number,
  ): Promise<Signature> {
    const prefix = await this.getPauseMessagePrefix();

    return await this.walletService.signPauseData({
      prefix,
      blockNumber,
      stakingModuleId,
    });
  }

  /**
   * Returns the current state of deposits
   */
  public async isDepositsPaused(
    stakingModuleId: number,
    blockTag?: BlockTag,
  ): Promise<boolean> {
    const stakingRouterContract =
      await this.repositoryService.getCachedStakingRouterContract();

    const isActive = await stakingRouterContract.getStakingModuleIsActive(
      stakingModuleId,
      {
        blockTag: blockTag as any,
      },
    );

    return !isActive;
  }

  /**
   * Sends a transaction to pause deposits
   * @param blockNumber - the block number for which the message is signed
   * @param stakingModuleId - target staking module id
   * @param signature - message signature
   */
  @OneAtTime()
  public async pauseDeposits(
    blockNumber: number,
    stakingModuleId: number,
    signature: Signature,
  ): Promise<ContractReceipt | void> {
    this.logger.warn('Try to pause deposits');
    this.pauseAttempts.inc();

    const contract = await this.getContractWithSigner();

    const { r, _vs: vs } = signature;

    const tx = await contract.pauseDeposits(blockNumber, stakingModuleId, {
      r,
      vs,
    });

    this.logger.warn('Pause transaction sent', { txHash: tx.hash });
    this.logger.warn('Waiting for block confirmation');

    await tx.wait();

    this.logger.warn('Block confirmation received');
  }
}
