import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { executionLogAbi } from './abi/executionLog.js';

// self-hosted hot-wallet relayer. r402 signs ExecutionLog.record() from
// RELAYER_PRIVATE_KEY; the on-chain ECDSA.recover still extracts the agent's
// signer from the signature payload, so tx.origin (this wallet) is irrelevant
// to attribution. handler re-confirms the receipt via Base RPC after this
// returns — do not duplicate revert detection here beyond what writeContract
// surfaces synchronously (simulation revert).

const EXECUTION_LOG_ADDRESS = '0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c';

export interface AnchorParams {
  payloadHash: Hex;
  signature:   Hex;
  timeoutMs?:  number;
}

export interface AnchorResult {
  txHash: Hex;
}

export class RelayerError    extends Error { constructor(m: string) { super(m); this.name = 'RelayerError';    } }
export class RelayerReverted extends Error { constructor(m: string) { super(m); this.name = 'RelayerReverted'; } }
export class RelayerTimeout  extends Error { constructor(m: string) { super(m); this.name = 'RelayerTimeout';  } }

export async function anchorViaHotWallet(p: AnchorParams): Promise<AnchorResult> {
  const pk     = process.env.RELAYER_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!pk)     throw new RelayerError('RELAYER_PRIVATE_KEY not set');
  if (!rpcUrl) throw new RelayerError('BASE_RPC_URL not set');

  const envTimeout = process.env.RELAYER_TIMEOUT_MS ? Number(process.env.RELAYER_TIMEOUT_MS) : undefined;
  const timeoutMs  = p.timeoutMs ?? envTimeout ?? 30_000;

  const account = privateKeyToAccount(pk as Hex);
  const wallet  = createWalletClient({
    account,
    chain:     base,
    transport: http(rpcUrl),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RelayerTimeout(`writeContract exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const txHash = await Promise.race([
      wallet.writeContract({
        address:      EXECUTION_LOG_ADDRESS,
        abi:          executionLogAbi,
        functionName: 'record',
        args:         [p.payloadHash, p.signature],
      }),
      deadline,
    ]);
    return { txHash };
  } catch (err) {
    if (err instanceof RelayerTimeout) throw err;
    if (
      err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionRevertedError)
    ) {
      throw new RelayerReverted(err.shortMessage || err.message);
    }
    throw new RelayerError(err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
