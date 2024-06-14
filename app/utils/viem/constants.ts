import { createPublicClient, http } from 'viem';
import { mainnet, base, optimism, arbitrum } from 'viem/chains';
import { contracts } from '@unlock-protocol/contracts';
import { getAlchemyRpc } from "../alchemy/constants";

const getClient = (network: string) => {
  let client = createPublicClient({
    chain: getViemNetwork(network),
    transport: http(), //http(getAlchemyRpc(network)),
  });
  return client;
};

const getViemNetwork = (network: string) => {
  switch (network) {
    case "ethereum":
      return mainnet;
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
  const name = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'name',
  });
  return name;
};

export const getLockIsValid = async (userAddress: string, lockAddress: string, network: string): Promise<any> => {
  let client = getClient(network);
  const isValid = await client.readContract({
    address: lockAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: 'getHasValidKey',
    args: [userAddress],
  });
  return isValid;
};