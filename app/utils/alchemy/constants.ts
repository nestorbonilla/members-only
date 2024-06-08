
export const getAlchemyRpc = (network: string): string => {
  switch (network) {
    case "ethereum":
      return `${process.env.ALCHEMY_RPC_URL_MAINNET}${process.env.ALCHEMY_API_KEY}`;
    case 'base':
      return `${process.env.ALCHEMY_RPC_URL_BASE}${process.env.ALCHEMY_API_KEY}`;
    case 'optimism':
      return `${process.env.ALCHEMY_RPC_URL_OPTIMISM}${process.env.ALCHEMY_API_KEY}`;
    case 'arbitrum':
      return `${process.env.ALCHEMY_RPC_URL_ARBITRUM}${process.env.ALCHEMY_API_KEY}`;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}