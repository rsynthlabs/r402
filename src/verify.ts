import {
  createPublicClient,
  http,
  parseAbiItem,
  decodeEventLog,
  decodeFunctionData,
  recoverMessageAddress,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

export interface VerifyResult {
  signer: Hex;
  payloadHash: Hex;
  signature: Hex;
  timestamp: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

const EXECUTION_LOG_ADDRESS = '0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c';

const EXECUTION_RECORDED_EVENT = parseAbiItem(
  'event ExecutionRecorded(address indexed signer, bytes32 indexed payloadHash, uint256 timestamp)',
);

const RECORD_FUNCTION = parseAbiItem(
  'function record(bytes32 payloadHash, bytes signature)',
);

export async function verifyAnchor(
  txHash: Hex,
  rpcUrl: string,
): Promise<VerifyResult> {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ]);

  if (receipt.status !== 'success') {
    throw new Error(`tx reverted: ${txHash}`);
  }

  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === EXECUTION_LOG_ADDRESS.toLowerCase(),
  );
  if (!log) {
    throw new Error(`no ExecutionRecorded log in tx ${txHash}`);
  }

  const decodedLog = decodeEventLog({
    abi: [EXECUTION_RECORDED_EVENT] as const,
    topics: log.topics,
    data: log.data,
  });
  const { signer, payloadHash, timestamp } = decodedLog.args;

  const decodedInput = decodeFunctionData({
    abi: [RECORD_FUNCTION] as const,
    data: tx.input,
  });
  const [, signature] = decodedInput.args;

  const recovered = await recoverMessageAddress({
    message: { raw: payloadHash },
    signature,
  });

  if (recovered.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(
      `signer mismatch in tx ${txHash}: expected ${signer}, recovered ${recovered}`,
    );
  }

  return {
    signer,
    payloadHash,
    signature,
    timestamp,
    blockNumber: receipt.blockNumber,
    txHash,
  };
}
