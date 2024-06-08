import { networks } from "@unlock-protocol/networks";
import { Web3Service } from "@unlock-protocol/unlock-js";
import { Membership } from "@/app/types";

interface GetHasValidKeyOptions {
  network: number;
  lockAddress: string;
  userAddress: string;
}

const web3Service = new Web3Service(networks);

export async function getValidKey({
  network,
  lockAddress,
  userAddress,
}: GetHasValidKeyOptions) {
  // const unlockWeb3Service = new Web3Service(networks);
  console.log("getValidKey => lockAddress: ", lockAddress);
  console.log("getValidKey => userAddress: ", userAddress);
  console.log("getValidKey => network: ", network);
  const key = await web3Service.getKeyByLockForOwner(
    lockAddress,
    userAddress,
    network
  );

  const keyId = key.tokenId;

  if (keyId <= 0) {
    return;
  }

  return {
    id: keyId,
    lockAddress,
    network,
  } as Membership;
}

export const getLockMetadata = async (lockAddress: string, network: string) => {
  let networkNumber = getNetworkNumber(network);
  console.log("getLockMetadata => lockAddress: ", lockAddress);
  console.log("getLockMetadata => networkNumber: ", networkNumber);
  let lockMetadata = await web3Service.getLock(lockAddress, networkNumber);
  console.log("getLockMetadata => lockMetadata: ", lockMetadata);
  return lockMetadata;
}

const getNetworkNumber = (network: string) => {
  switch (network) {
    case "ethereum":
      return networks['1'].id;
    case "base":
      return networks['8453'].id;
    case "optimism":
      return networks['10'].id;
    case "arbitrum":
      return networks['42161'].id;
    default:
      return networks['1'].id;
  }
}

export const getUnlockProxyAddress = (network: string) => {
  switch (network) {
    case "ethereum":
      return networks['1'].unlockAddress;
    case "base":
      return networks['8453'].unlockAddress;
    case "optimism":
      return networks['10'].unlockAddress;
    case "arbitrum":
      return networks['42161'].unlockAddress;
    default:
      return networks['1'].unlockAddress;
  }
};

export async function hasMembership(userAddress: string, network: string) {
  if (await web3Service.getHasValidKey(
    getUnlockProxyAddress(network),
    userAddress,
    getNetworkNumber(network)
  )) {
    return true;
  } else {
    return false;
  }
}

export async function fetchJson<JSON = unknown>(
  input: RequestInfo,
  init?: RequestInit
): Promise<JSON> {
  const response = await fetch(input, init);
  const data = await response.json();
  if (response.ok) {
    return data;
  }
  throw new FetchError({
    message: response.statusText,
    response,
    data,
  });
}

export class FetchError extends Error {
  response: Response;
  data: {
    message: string;
  };
  constructor({
    message,
    response,
    data,
  }: {
    message: string;
    response: Response;
    data: {
      message: string;
    };
  }) {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FetchError);
    }
    this.name = "FetchError";
    this.response = response;
    this.data = data ?? { message: message };
  }
}
