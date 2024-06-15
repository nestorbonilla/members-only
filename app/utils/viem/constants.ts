import { createPublicClient, http } from 'viem';
import { mainnet, base, optimism, arbitrum } from 'viem/chains';
import { contracts } from '@unlock-protocol/contracts';
import internal from 'stream';

const getClient = (network: string) => {
  let client = createPublicClient({
    chain: getViemNetwork(network),
    transport: http(), //http(getAlchemyRpc(network)),
  });
  return client;
};

const getViemNetwork = (network: string) => {
  switch (network) {
    case "base":
      return base;
    case "optimism":
      return optimism;
    case "arbitrum":
      return arbitrum;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

export const getMembersOnlyReferralFee = async (contractAddress: string, network: string): Promise<any> => {
  let client = getClient(network);
  let referralFee = await client.readContract({
    address: contractAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: "referrerFees",
    args: [process.env.MO_ADDRESS],
  });
  return referralFee;
};

export const getLockName = async (lockAddress: string, network: string): Promise<any> => {
  let client = getClient(network);
  let lockName = "";
  try {
    let readContractResult = await client.readContract({
      address: lockAddress as `0x${string}`,
      abi: contracts.PublicLockV14.abi,
      functionName: 'name',
    });
    lockName = readContractResult!.toString();
  } catch (error) {
    console.log('Contract address not a Lock contract.');
  }
  return lockName;
};

export const getLockIsValid = async (userAddress: string, lockAddress: string, network: string): Promise<any> => {
  let client = getClient(network);
  const isValid = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'getHasValidKey',
    args: [userAddress],
  });
  console.log(`Does ${userAddress} have a valid membership in ${lockAddress} deployed on ${network}? ${isValid}`);
  return isValid;
};

export const getLockTotalKeys = async (userAddress: string, lockAddress: string, network: string): Promise<any> => {
  let client = getClient(network);
  const count = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'totalKeys',
    args: [userAddress],
  });
  console.log(`How many keys does ${userAddress} have in lock ${lockAddress} deployed on ${network}? It has ${count}`);
  return count;
};

export const getTokenOfOwnerByIndex = async (userAddress: string, index: Number, lockAddress: string, network: string): Promise<any> => {
  let client = getClient(network);
  const count = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'tokenOfOwnerByIndex',
    args: [userAddress, index],
  });
  return count;
};

export const doAddressesHaveValidMembershipInRules = async (
  userAddresses: string[],
  channelRules: {
    id: number,
    channel_id: string,
    operator: string,
    rule_behavior: string,
    network: string,
    contract_address: string,
    created_at: string,
    updated_at: string | null
  }[]
) => {
  const membershipPromises = userAddresses.flatMap(userAddress =>
    channelRules.map(rule => getLockIsValid(userAddress, rule.contract_address, rule.network))
  );

  try {
    await Promise.any(membershipPromises); // Wait for at least ONE to resolve
    return true; // At least one membership is valid
  } catch (error) {
    // If ALL promises are rejected (no valid membership found)
    return false;
  }
};