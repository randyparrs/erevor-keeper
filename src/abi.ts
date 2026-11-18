// Minimal ABI of the Erevor contracts on Elysium: only the functions, events and errors the keeper uses.
// Regenerate from the contract build output if the deployed contracts change.

export const predictionMarketAbi = [
  {
    "type": "function",
    "name": "bufferSeconds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "executeBoundary",
    "inputs": [
      {
        "name": "marketIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getMarketIds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRound",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PredictionMarket.Round",
        "components": [
          {
            "name": "marketId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "configHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "priceSource",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "interval",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum PredictionMarket.RoundStatus"
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum PredictionMarket.Outcome"
          },
          {
            "name": "feeCollected",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "lockTimestamp",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "closeTimestamp",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "claimableAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "upAmount",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "downAmount",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lockPrice",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "closePrice",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "rewardBase",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "rewardAmount",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "fee",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "claimedWinnerStake",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "paidOut",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lockPriceTimestamp",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "closePriceTimestamp",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hasRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "markets",
    "inputs": [
      {
        "name": "marketId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "interval",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "exists",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "lastBoundary",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "configNonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "configHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "priceSource",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IPriceSource"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "BoundaryExecuted",
    "inputs": [
      {
        "name": "marketId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "boundary",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "price",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceTimestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MarketSkipped",
    "inputs": [
      {
        "name": "marketId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PredictionMarket.SkipReason"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PriceRebased",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "oldReference",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newReference",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PriceRejected",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previous",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "rejected",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RebasePending",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "pendingReference",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "count",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundClosed",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "closePrice",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceTimestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "referencePrice",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "referenceTimestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PredictionMarket.Outcome"
      },
      {
        "name": "rewardBase",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "rewardAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "claimableAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundLocked",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "lockPrice",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceTimestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "referencePrice",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "referenceTimestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "lockTimestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundVoided",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PredictionMarket.VoidReason"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccessControlBadConfirmation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "neededRole",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "AlreadyClaimed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AssetExists",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "AssetNotListed",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "BetTooSmall",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minBet",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "BettingClosed",
    "inputs": [
      {
        "name": "start",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "ClaimTooEarly",
    "inputs": [
      {
        "name": "claimableAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "DisputeExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DisputeNotExpired",
    "inputs": [
      {
        "name": "timeoutAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "DisputesDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExclusionCannotShorten",
    "inputs": [
      {
        "name": "current",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeeTooHigh",
    "inputs": [
      {
        "name": "feeBps",
        "type": "uint16",
        "internalType": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientTreasury",
    "inputs": [
      {
        "name": "requested",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "available",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidAsset",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidInterval",
    "inputs": [
      {
        "name": "interval",
        "type": "uint32",
        "internalType": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidParam",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSide",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketExists",
    "inputs": [
      {
        "name": "marketId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "MarketInactive",
    "inputs": [
      {
        "name": "marketId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoPendingChange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPosition",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotDisputable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotDisputed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToClaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundFrozen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundNotBettable",
    "inputs": [
      {
        "name": "start",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "expected",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "RoundNotSettled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SelfExclusionActive",
    "inputs": [
      {
        "name": "until",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "SideMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TimelockNotElapsed",
    "inputs": [
      {
        "name": "eta",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownMarket",
    "inputs": [
      {
        "name": "marketId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;

export const keeperSignedPriceSourceAbi = [
  {
    "type": "function",
    "name": "hasRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pushPrices",
    "inputs": [
      {
        "name": "assetIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      },
      {
        "name": "prices",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "error",
    "name": "AccessControlBadConfirmation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "neededRole",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidMaxPriceAge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LengthMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceNotSet",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "StalePrice",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "TimestampInFuture",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "TimestampNotIncreasing",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "current",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroPrice",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  }
] as const;
