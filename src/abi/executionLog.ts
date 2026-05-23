// minimal vendor of the ExecutionLog ABI — only what the relayer + verifier
// touch. matches sdk/contracts/src/ExecutionLog.sol. if upstream redeploys
// with a new shape, this and src/verify.ts (which uses parseAbiItem for the
// same signatures) drift together.

export const executionLogAbi = [
  {
    type: 'function',
    name: 'record',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payloadHash', type: 'bytes32' },
      { name: 'signature',   type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'ExecutionRecorded',
    anonymous: false,
    inputs: [
      { name: 'signer',      type: 'address', indexed: true  },
      { name: 'payloadHash', type: 'bytes32', indexed: true  },
      { name: 'timestamp',   type: 'uint256', indexed: false },
    ],
  },
] as const;
