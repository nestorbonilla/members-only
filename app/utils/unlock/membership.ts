// import { paywallConfig } from "~/config/unlock";
import { base, networks } from "@unlock-protocol/networks";
import { Web3Service } from "@unlock-protocol/unlock-js";
import { Membership } from "@/app/types";
interface GetHasValidKeyOptions {
  network: number;
  lockAddress: string;
  userAddress: string;
}

const paywallConfig = {
  locks: {
    '0x99c1e087ba034c655deff866e9e043fff1abb7e3': {
      name: '8453',
      network: 8453,
    },
  }
}

const web3Service = new Web3Service({
  "8453": {
    publicProvider: `${process.env.ALCHEMY_URL_BASE}${process.env.ALCHEMY_API_KEY}/`,
    provider: `${process.env.ALCHEMY_URL_BASE}${process.env.ALCHEMY_API_KEY}/`,
  },
});

export async function getValidKey({
  network,
  lockAddress,
  userAddress,
}: GetHasValidKeyOptions) {
  // const unlockWeb3Service = new Web3Service(networks);
  console.log("hey,lockAddress: ", lockAddress);
  console.log("hey,userAddress: ", userAddress);
  console.log("hey,network: ", network);
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

export const getLockMetadata = async (lockAddress: string) => {
  return await web3Service.getLock(lockAddress, 8453);
}
// export async function getValidMemberships(userAddress: string) {
//   const promises = Object.keys(paywallConfig.locks as any).map(
//     (lockAddress) => {
//       return getValidKey({
//         lockAddress,
//         userAddress,
//         network: (paywallConfig.locks as any)[lockAddress].network,
//       });
//     }
//   );
//   const results = await Promise.all(promises);
//   return results as Membership[];
// }

// export async function hasMembership(userAddress: string) {
//   const results = await getValidMemberships(userAddress);
//   return !!results.length;
// }

export async function hasMembership(userAddress: string) {
  for (const [lockAddress, { network }] of Object.entries<{ network: number }>(
    paywallConfig.locks
  )) {
    if (await web3Service.getHasValidKey(
      lockAddress,
      userAddress,
      network
    )) {
      return true;
    }
  }
  return false;
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
