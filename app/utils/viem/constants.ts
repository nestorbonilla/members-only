import { createPublicClient, http, erc20Abi, isAddress } from 'viem';
import { base, optimism, arbitrum } from 'viem/chains';
import { contracts } from '@unlock-protocol/contracts';

const getClient = (network: string) => {
  let client = createPublicClient({
    chain: getViemNetwork(network),
    transport: http(), //http(getAlchemyRpc(network)),
  });
  return client;
};

const getViemNetwork = (network: string) => {
  switch (network) {
    case 'base':
      return base;
    case 'optimism':
      return optimism;
    case 'arbitrum':
      return arbitrum;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
};

export const getMembersOnlyReferralFee = async (
  contractAddress: string,
  network: string
): Promise<bigint | null> => {
  try {
    if (!isAddress(contractAddress)) {
      throw new Error(`Invalid contract address: ${contractAddress}`);
    }

    let client = getClient(network);

    const referralFee = (await client.readContract({
      address: contractAddress,
      abi: contracts.PublicLockV14.abi,
      functionName: 'referrerFees',
      args: [process.env.MO_ADDRESS!],
    })) as bigint | null;

    return referralFee; // referralFee is already a bigint
  } catch (error) {
    console.error(
      `Error fetching referral fee for ${contractAddress} on ${network}:`,
      error
    );
    return null;
  }
};

export const getLockName = async (
  lockAddress: string,
  network: string
): Promise<string | null> => {
  let client = getClient(network);
  try {
    if (!isAddress(lockAddress)) {
      throw new Error(`Invalid contract address: ${lockAddress}`);
    }
    let readContractResult = await client.readContract({
      address: lockAddress,
      abi: contracts.PublicLockV14.abi,
      functionName: 'name',
    });
    let lockName = readContractResult!.toString();
    return lockName;
  } catch (error) {
    console.error(
      `Error fetching lock name for ${lockAddress} on ${network}:`,
      error
    );
    return null;
  }
};

export const getLockIsValid = async (
  userAddress: string,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const isValid = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'getHasValidKey',
    args: [userAddress],
  });
  console.log(
    `Does ${userAddress} have a valid membership in ${lockAddress} deployed on ${network}? ${isValid}`
  );
  return isValid;
};

export const getLockTotalKeys = async (
  userAddress: string,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const count = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'totalKeys',
    args: [userAddress],
  });
  console.log(
    `How many keys does ${userAddress} have in lock ${lockAddress} deployed on ${network}? It has ${count}`
  );
  return count;
};

export const getLockTokenAddress = async (
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const tokenAddress = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'tokenAddress',
    args: [],
  });
  console.log(
    `What's the address of the erc20 price of the lock ${lockAddress} deployed on ${network}? It is ${tokenAddress}`
  );
  return tokenAddress;
};

export const getLockPrice = async (
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const price = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'keyPrice',
    args: [],
  });
  console.log(
    `What's the price of a lock ${lockAddress} deployed on ${network}? It is ${price}`
  );
  return price;
};

export const getTotalSupply = async (
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const totalSupply = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'totalSupply',
    args: [],
  });
  console.log(
    `What's the total supply of the lock ${lockAddress} deployed on ${network}? It is ${totalSupply}`
  );
  return totalSupply;
};

export const getBalanceOf = async (
  userAddress: string,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const balance = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'balanceOf',
    args: [userAddress],
  });
  console.log(
    `What's the balance of the lock ${lockAddress} deployed on ${network} for address ${userAddress}? It is ${balance}`
  );
  return balance;
};

export const getIsValidKey = async (
  tokenId: number,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const isValid = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'isValidKey',
    args: [tokenId],
  });
  console.log(
    `Is key number ${tokenId} a valid key for the lock ${lockAddress} deployed on ${network}?${isValid}`
  );
  return isValid;
};

export const getFirstTokenIdOfOwner = async (
  userAddresses: string[],
  totalKeysCount: number,
  lockAddress: string,
  network: string
): Promise<{ tokenId: number; isValid: number, userAddress: string } | null> => {
  for (const userAddress of userAddresses) {
    for (let index = 0; index < totalKeysCount; index++) {
      try {
        const tokenId = await getTokenOfOwnerByIndex(
          userAddress,
          index,
          lockAddress,
          network
        );
        if (tokenId) {
          const isValid = await getIsValidKey(tokenId, lockAddress, network);
          return { tokenId, isValid, userAddress };
        }
      } catch (error) {
        console.log(`No key with index ${index} found on address ${userAddress}`);
      }
    }
  }
  return null; // No owned keys found on all addresses
};

export const getTokenOfOwnerByIndex = async (
  userAddress: string,
  index: number,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const count = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'tokenOfOwnerByIndex',
    args: [userAddress, index],
  });
  return count;
};

export const getTokenExpiration = async (
  tokenId: number,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const expiration = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'keyExpirationTimestampFor',
    args: [tokenId],
  });
  console.log(
    `What's the expiration date of the token ${tokenId} in lock ${lockAddress} deployed on ${network}? It is ${expiration}`
  );
  return expiration;
};

export const doAddressesHaveValidMembershipInRules = async (
  userAddresses: string[],
  channelRules: {
    id: number;
    channel_id: string;
    operator: string;
    rule_behavior: string;
    network: string;
    contract_address: string;
    created_at: string;
    updated_at: string | null;
  }[]
): Promise<boolean> => {
  for (const userAddress of userAddresses) {
    for (const rule of channelRules) {
      const isValid = await getLockIsValid(
        userAddress,
        rule.contract_address,
        rule.network
      );
      if (isValid) {
        return true; // Found a valid membership, so return early
      }
    }
  }
  return false; // No valid membership found after checking all combinations
};

export const getErc20Allowance = async (
  userAddress: string,
  tokenAddress: string,
  lockAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const allowance = await client.readContract({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress as `0x${string}`, lockAddress as `0x${string}`],
  });
  return allowance;
};

export const getErc20Symbol = async (
  tokenAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const symbol = await client.readContract({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'symbol',
    args: [],
  });
  return symbol;
};

export const getErc20Decimals = async (
  tokenAddress: string,
  network: string
): Promise<any> => {
  let client = getClient(network);
  const allowance = await client.readContract({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'decimals',
    args: [],
  });
  return allowance;
};
