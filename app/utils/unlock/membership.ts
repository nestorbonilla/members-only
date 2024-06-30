import { networks } from '@unlock-protocol/networks';

export const getUnlockProxyAddress = (network: string) => {
  switch (network) {
    case 'base':
      return networks['8453'].unlockAddress;
    case 'optimism':
      return networks['10'].unlockAddress;
    case 'arbitrum':
      return networks['42161'].unlockAddress;
    default:
      return networks['8453'].unlockAddress;
  }
};
