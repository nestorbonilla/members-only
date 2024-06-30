import { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { config } from 'dotenv';

config();

if (!process.env.NEYNAR_API_KEY) {
  throw new Error('Make sure you set NEYNAR_API_KEY in your .env file');
}

const neynarClient = new NeynarAPIClient(process.env.NEYNAR_API_KEY);

export default neynarClient;

export const getEipChainId = (network: string) => {
  switch (network) {
    case 'base':
      return 'eip155:8453';
    case 'optimism':
      return 'eip155:10';
    case 'arbitrum':
      return 'eip155:42161';
    default:
      return 'eip155:8453';
  }
};
