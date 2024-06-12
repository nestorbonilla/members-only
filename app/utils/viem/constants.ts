import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { contracts } from '@unlock-protocol/contracts';

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

export const getMembersOnlyReferralFee = async (contractAddress: string): Promise<any> => {
  let referralFee = await publicClient.readContract({
    address: contractAddress as `0x${string}`,
    abi: contracts.PublicLockV14.abi,
    functionName: "referrerFees",
    args: [process.env.MO_ADDRESS],
  });
  return referralFee;
};