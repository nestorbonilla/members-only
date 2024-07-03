import { getUnlockProxyAddress } from '../unlock/membership';

export const getAlchemyRpc = (network: string): string => {
  switch (network) {
    case 'base':
      return `${process.env.ALCHEMY_RPC_URL_BASE}${process.env.ALCHEMY_API_KEY}`;
    case 'optimism':
      return `${process.env.ALCHEMY_RPC_URL_OPTIMISM}${process.env.ALCHEMY_API_KEY}`;
    case 'arbitrum':
      return `${process.env.ALCHEMY_RPC_URL_ARBITRUM}${process.env.ALCHEMY_API_KEY}`;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
};

export const getContractsDeployed = async (
  userAddress: string,
  network: string
): Promise<string[]> => {
  let alchemyRpc = getAlchemyRpc(network);
  try {
    const txWithProxy = await fetch(alchemyRpc, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'alchemy_getAssetTransfers',
        params: [
          {
            fromBlock: '0x0',
            toBlock: 'latest',
            fromAddress: userAddress,
            toAddress: getUnlockProxyAddress(network),
            category: ['external'],
            order: 'desc',
            withMetadata: true,
            excludeZeroValue: false, // it needs to include zero values
          },
        ],
      }),
      next: {
        revalidate: 600,
      },
    });
    const txWithProxyData = await txWithProxy.json();
    if (!txWithProxyData.result || !txWithProxyData.result.transfers) {
      console.error(
        `getContractsDeployed error: 'result' or 'transfers' not found in alchemy_getAssetTransfers response for address: ${userAddress}, network: ${network}`,
        txWithProxyData
      );
      return [];
    }

    const txHashes: string[] = txWithProxyData.result.transfers.map(
      (tx: any) => tx.hash
    );

    if (txHashes.length === 0) {
      return [];
    }

    const allReceiptPromises = await Promise.all(
      txHashes.map(async (txHash: string) => {
        const response = await fetch(alchemyRpc, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getTransactionReceipt',
            params: [txHash],
          }),
          next: {
            revalidate: 600,
          },
        });

        if (!response.ok) {
          throw new Error(`Request for hash ${txHash} failed`);
        }

        const data = await response.json();
        return data?.result; // Extract the receipts from the response
      })
    );
    const allReceipts = await Promise.all(allReceiptPromises);
    const contractAddresses = allReceipts.flatMap((receipt) => {
      if (receipt.logs && receipt.logs.length > 0) {
        const firstLog = receipt.logs[0]; // There could be logs that have a different address, but I'm assuming the first one is the contract address
        return firstLog.address;
      } else {
        return [];
      }
    });
    return contractAddresses;
  } catch (error) {
    console.error('Error in getContractsDeployed requests:', error);
    return [];
  }
};
